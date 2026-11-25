package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type endpoint func(http.ResponseWriter, *http.Request) (any, error)

func route(status int, fn endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		value, err := fn(w, r)
		code := status
		if err != nil {
			var p problem
			if errors.As(err, &p) {
				code = p.code
				value = fields{"detail": p.message}
			} else {
				log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
				code = 503
				value = fields{"detail": "Storage temporarily unavailable."}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(value)
	}
}

var idPattern = regexp.MustCompile("^[0-9a-f]{32}$")

func (s *service) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /events", s.events)
	m.HandleFunc("GET /reports", route(200, s.reports))
	m.HandleFunc("GET /health", route(200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		return fields{"status": "ok", "model": s.model, "provider_configured": s.key != "", "max_upload_bytes": s.maxBytes, "summary_languages": languages}, nil
	}))
	for _, path := range []string{"/live", "/ready"} {
		m.HandleFunc("GET "+path, route(200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
			if err := s.db.Ping(r.Context()).Err(); err != nil {
				return nil, err
			}
			if path == "/ready" {
				if s.key == "" {
					return nil, problem{503, "GEMINI_API_KEY is not configured."}
				}
				if _, err := os.Stat(s.root); err != nil {
					return nil, err
				}
				return fields{"status": "ready"}, nil
			}
			return fields{"status": "ok"}, nil
		}))
	}
	m.HandleFunc("GET /documents/{id}/source", func(w http.ResponseWriter, r *http.Request) {
		d, err := s.fromRequest(r)
		if err != nil {
			if errors.Is(err, missing) {
				http.NotFound(w, r)
			} else {
				http.Error(w, "Storage temporarily unavailable.", 503)
			}
			return
		}
		file, err := os.Open(filepath.Join(s.root, d.ID, "source.pdf"))
		if err != nil {
			if os.IsNotExist(err) {
				http.NotFound(w, r)
			} else {
				http.Error(w, "Cannot read PDF.", 503)
			}
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": d.Filename}))
		http.ServeContent(w, r, d.Filename, time.Time{}, file)
	})
	m.HandleFunc("POST /documents", route(202, s.upload))
	m.HandleFunc("GET /documents", route(200, s.list))
	m.HandleFunc("GET /documents/{id}", route(200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		d, e := s.fromRequest(r)
		if e != nil {
			return nil, e
		}
		return d.view(r.URL.Query().Get("summary_version"))
	}))
	m.HandleFunc("GET /documents/{id}/pages", route(200, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		d, e := s.fromRequest(r)
		if e != nil {
			return nil, e
		}
		o, l, e := pagination(r, 50)
		if e != nil {
			return nil, e
		}
		items, e := s.pages(r.Context(), d, o, l)
		return fields{"total": d.Count, "items": items, "offset": o, "limit": l}, e
	}))
	m.HandleFunc("PATCH /documents/{id}/summary", route(200, s.edit))
	m.HandleFunc("POST /documents/{id}/summary/regenerate", route(202, s.regenerate))
	m.HandleFunc("GET /docs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, docsHTML)
	})
	m.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(spec)
	})
	return m
}
func (s *service) fromRequest(r *http.Request) (*Document, error) {
	id := r.PathValue("id")
	if !idPattern.MatchString(id) {
		return nil, missing
	}
	return s.document(r.Context(), id)
}
func pagination(r *http.Request, max int) (int, int, error) {
	o, l := 0, 20
	var err error
	if r.URL.Query().Has("offset") {
		o, err = strconv.Atoi(r.URL.Query().Get("offset"))
		if err != nil || o < 0 || o > 1<<31-1 {
			return 0, 0, problem{422, "Invalid offset."}
		}
	}
	if r.URL.Query().Has("limit") {
		l, err = strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || l < 1 || l > max {
			return 0, 0, problem{422, "Invalid limit."}
		}
	}
	return o, l, nil
}
func (s *service) list(_ http.ResponseWriter, r *http.Request) (any, error) {
	o, l, err := pagination(r, 100)
	if err != nil {
		return nil, err
	}
	order, err := parseOrdering(r, "created_at", "desc")
	if err != nil {
		return nil, err
	}
	report, err := s.snapshot(r.Context())
	if err != nil {
		return nil, err
	}
	items := []fields{}
	for _, row := range order.page(report.Rows, o, l) {
		var count any
		if row.Pages > 0 {
			count = strconv.Itoa(row.Pages)
		}
		items = append(items, fields{"id": row.ID, "filename": row.Filename, "state": row.State, "created_at": fmt.Sprint(row.Created), "last_regenerated_at": row.Regenerated, "size_bytes": fmt.Sprint(row.Bytes), "page_count": count})
	}
	return fields{"items": items, "total": report.Total}, nil
}
func (s *service) upload(w http.ResponseWriter, r *http.Request) (any, error) {
	q := r.URL.Query()
	name := q.Get("filename")
	parser := q.Get("parser")
	lang := q.Get("summary_language")
	if !q.Has("parser") {
		parser = "gemini"
	}
	if !q.Has("summary_language") {
		lang = "en"
	}
	key := r.Header.Get("Idempotency-Key")
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 240 || len(key) > 200 || languages[lang] == "" || (parser != "gemini" && parser != "pypdf" && parser != "poppler") {
		return nil, problem{422, "Invalid filename, parser, summary language or upload key."}
	}
	typ, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if typ != "application/pdf" && typ != "application/octet-stream" {
		return nil, problem{415, "Send a raw application/pdf body."}
	}
	if r.ContentLength > s.maxBytes {
		return nil, problem{413, "Upload exceeds the configured size limit."}
	}
	response := func(id string, reused bool) fields {
		return fields{"id": id, "status_url": "/documents/" + id, "reused": reused}
	}
	ctx := r.Context()
	existing, err := s.reused(ctx, key, name, parser, lang)
	if err != nil {
		return nil, err
	}
	if existing != "" {
		return response(existing, true), nil
	}
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		return nil, capacity
	}
	id := randomID()
	dir := filepath.Join(s.root, id)
	if err = os.Mkdir(dir, 0700); err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			os.RemoveAll(dir)
		}
	}()
	f, err := os.Create(filepath.Join(dir, "source.pdf"))
	if err != nil {
		return nil, err
	}
	body := http.MaxBytesReader(w, r.Body, s.maxBytes)
	head, err := io.ReadAll(io.LimitReader(body, 1024))
	if err == nil && !bytes.Contains(head, []byte("%PDF-")) {
		f.Close()
		return nil, problem{422, "The upload does not have a PDF header."}
	}
	var size int64
	if err == nil {
		size, err = copyUpload(f, io.MultiReader(bytes.NewReader(head), body), s.root, s.minFreeBytes)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, problem{413, "Upload exceeds the configured size limit."}
		}
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	d := Document{ID: id, Filename: name, State: "queued", Parser: parser, Language: lang, OriginalLanguage: lang, Model: s.model, Created: now(), Size: size, Warnings: []string{}, Errors: []Failure{}, Versions: []Version{}, MissingExtraction: []int{}, MissingSummary: []int{}, Metadata: map[string]string{}}
	existing, err = s.register(ctx, &d, key)
	if err != nil {
		// A lost transaction reply can mean Redis committed. Keep the PDF in that case.
		verify, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, e := readDoc(verify, s.db, id)
		keep = !errors.Is(e, missing)
		return nil, err
	}
	if existing != "" {
		return response(existing, true), nil
	}
	keep = true
	return response(id, false), nil
}

type summaryInput struct {
	Revision *int   `json:"revision"`
	Markdown string `json:"markdown"`
	Version  string `json:"version_id"`
	Language string `json:"language"`
}

func input(w http.ResponseWriter, r *http.Request) (summaryInput, error) {
	var v summaryInput
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	if err := dec.Decode(&v); err != nil || v.Revision == nil || *v.Revision < 0 {
		return v, problem{422, "A valid JSON body and non-negative revision are required."}
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return v, problem{422, "Invalid JSON body."}
	}
	return v, nil
}
func (s *service) edit(w http.ResponseWriter, r *http.Request) (any, error) {
	d, err := s.fromRequest(r)
	if err != nil {
		return nil, err
	}
	v, err := input(w, r)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(v.Markdown) == "" || utf8.RuneCountInString(v.Markdown) > 10000 {
		return nil, problem{422, "Summary must contain 1 to 10000 characters."}
	}
	var result fields
	err = s.update(r.Context(), d.ID, "", func(d *Document, _ redis.Pipeliner) error {
		if d.State != "completed" && d.State != "partial" {
			return busy
		}
		for i := range d.Versions {
			version := &d.Versions[i]
			if (v.Version == "" && i == 0) || v.Version == version.ID {
				expected := version.Revision
				if v.Version == "" {
					expected = d.Revision
				}
				if *v.Revision != expected {
					return conflict
				}
				t := now()
				version.Edited = &t
				version.Override = &v.Markdown
				version.Revision++
				d.Revision++
				var e error
				result, e = d.view(v.Version)
				return e
			}
		}
		return problem{404, "Summary version not found."}
	})
	return result, err
}
func (s *service) regenerate(w http.ResponseWriter, r *http.Request) (any, error) {
	d, err := s.fromRequest(r)
	if err != nil {
		return nil, err
	}
	v, err := input(w, r)
	if err != nil {
		return nil, err
	}
	if languages[v.Language] == "" {
		return nil, problem{422, "Unknown summary language."}
	}
	ctx := r.Context()
	var result fields
	err = s.update(ctx, d.ID, "", func(d *Document, p redis.Pipeliner) error {
		if !d.terminal() {
			return busy
		}
		if *v.Revision != d.Revision {
			return conflict
		}
		if d.Progress.Extracted == 0 {
			return problem{409, "No extracted pages available."}
		}
		d.Generation++
		count, err := s.db.SCard(ctx, activeKey).Result()
		if err != nil {
			return err
		}
		if count >= int64(s.maxActive) {
			return capacity
		}
		d.Pending = v.Language
		d.Model = s.model
		d.State = "summarizing"
		d.Finished = nil
		d.Progress.Summarized = 0
		d.MissingSummary = []int{}
		d.Errors = []Failure{}
		d.Warnings = []string{}
		d.Revision++
		p.ZRem(ctx, expiryKey, d.ID)
		p.SAdd(ctx, activeKey, d.ID)
		p.XAdd(ctx, &redis.XAddArgs{Stream: queue, Values: fields{"id": d.ID}})
		var e error
		result, e = d.view("")
		return e
	}, activeKey)
	return result, err
}
