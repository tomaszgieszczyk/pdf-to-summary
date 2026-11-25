package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testService(t *testing.T) *service {
	t.Helper()
	server := miniredis.RunT(t)
	db := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { db.Close() })
	return &service{db: db, root: t.TempDir(), maxBytes: 1 << 20, maxActive: 5, uploads: make(chan struct{}, 5), model: "test-model", key: "test", retention: time.Hour}
}
func call(t *testing.T, h http.Handler, method, path, body string, want int, headers ...string) fields {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for i := 0; i < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("%s %s: %d, want %d: %s", method, path, rec.Code, want, rec.Body)
	}
	var result fields
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func TestUploadIdempotency(t *testing.T) {
	s := testService(t)
	h := s.routes()
	path := "/documents?filename=test.pdf&parser=pypdf"
	headers := []string{"Content-Type", "application/pdf", "Idempotency-Key", "same"}
	call(t, h, "POST", path, "invalid", 422, headers...)
	first := call(t, h, "POST", path, "%PDF-1.4", 202, headers...)
	next := call(t, h, "POST", path, "%PDF-1.4", 202, headers...)
	if first["id"] != next["id"] || next["reused"] != true {
		t.Fatal(next)
	}
	call(t, h, "POST", path+"&summary_language=pl", "%PDF-1.4", 409, headers...)
	call(t, h, "GET", "/documents?offset=-1", "", 422)
	if jobs := s.db.XLen(t.Context(), queue).Val(); jobs != 1 {
		t.Fatalf("got %d jobs", jobs)
	}
	if got := call(t, h, "GET", "/documents", "", 200); got["total"] != float64(1) {
		t.Fatal(got)
	}
}

func TestResumeFromPublishedCheckpoints(t *testing.T) {
	s := testService(t)
	ctx := t.Context()
	d := Document{ID: randomID(), Filename: "resume.pdf", Parser: "poppler", Count: 2, State: "summarizing", Model: s.model, Language: "en", Progress: Progress{Prepared: 2, Extracted: 1, Summarized: 1}, MissingExtraction: []int{2}, MissingSummary: []int{2}}
	if _, err := s.register(ctx, &d, ""); err != nil {
		t.Fatal(err)
	}
	text := "Page text"
	for _, p := range []Page{{Number: 1, Markdown: &text, Extraction: "completed"}, {Number: 2, Extraction: "failed"}} {
		b, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		if err = s.db.HSet(ctx, pageKey(d.ID), fmt.Sprint(p.Number), b).Err(); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.db.HSet(ctx, notesKey(&d), "1", "Saved summary", "2", "").Err(); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.db.XRange(ctx, queue, "-", "+").Result()
	if err != nil || len(jobs) != 1 {
		t.Fatal(jobs, err)
	}
	if err = s.runJob(ctx, d.ID, jobs[0].ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.document(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "partial" || got.Progress != d.Progress || len(got.Versions) != 1 || !strings.Contains(got.Versions[0].Text, "Saved summary") {
		t.Fatal(got)
	}
	if err = s.runJob(ctx, d.ID, jobs[0].ID); err != nil {
		t.Fatal(err)
	}
	if s.db.XLen(ctx, queue).Val() != 0 || s.db.SCard(ctx, activeKey).Val() != 0 {
		t.Fatal("completed job still active")
	}
}

// Generate a one-page PDF with a real text layer and cross-reference table.
func fixturePDF() string {
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	stream := "BT /F1 12 Tf 40 100 Td (Solar project revenue) Tj ET"
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}
	offsets := []int{}
	for i, o := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 6\n0000000000 65535 f \n")
	for _, offset := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.String()
}
func TestDocumentLifecycle(t *testing.T) {
	for _, bin := range []string{"pdfinfo", "pdfseparate", "pdftotext"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip("install Poppler to run the PDF integration test")
		}
	}
	for _, parser := range []string{"poppler", "gemini"} {
		t.Run(parser, func(t *testing.T) {
			s := testService(t)
			var calls atomic.Int32
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				b, _ := io.ReadAll(r.Body)
				if r.Header.Get("x-goog-api-key") != "test" || r.URL.Path != "/models/test-model:generateContent" {
					t.Error("incorrect provider request")
				}
				text := "Summary of solar project revenue"
				if bytes.Contains(b, []byte("inlineData")) {
					text = "Solar project revenue"
				} else if !bytes.Contains(b, []byte("Solar project revenue")) {
					t.Error("missing source text")
				}
				if bytes.Contains(b, []byte("Polish")) {
					text = "Przychody projektu"
				}
				json.NewEncoder(w).Encode(fields{"candidates": []fields{{"finishReason": "STOP", "content": fields{"parts": []fields{{"text": text}}}}}})
			}))
			defer fake.Close()
			// A zero TTL is persistent in Redis. Advance the isolated clock after every slot acquisition instead.
			mini := miniredis.RunT(t)
			rateDB := redis.NewClient(&redis.Options{Addr: mini.Addr()})
			defer rateDB.Close()
			clock, stop := context.WithCancel(t.Context())
			defer stop()
			go func() {
				for wait(clock, time.Millisecond) == nil {
					mini.FastForward(time.Second)
				}
			}()
			s.provider = &gemini{db: rateDB, client: fake.Client(), endpoint: fake.URL, model: s.model, key: s.key, interval: time.Millisecond}
			h := s.routes()
			upload := call(t, h, "POST", "/documents?filename=demo.pdf&parser="+parser, fixturePDF(), 202, "Content-Type", "application/pdf")
			id := upload["id"].(string)
			path := "/documents/" + id
			process := func() {
				t.Helper()
				jobs, err := s.db.XRange(t.Context(), queue, "-", "+").Result()
				if err != nil || len(jobs) != 1 {
					t.Fatalf("jobs: %v %v", jobs, err)
				}
				if err = s.runJob(t.Context(), id, jobs[0].ID); err != nil {
					t.Fatal(err)
				}
			}
			process()
			d := call(t, h, "GET", path, "", 200)
			if d["state"] != "completed" || d["summary_version_id"] != "g0" {
				t.Fatal(d)
			}
			p := call(t, h, "GET", path+"/pages", "", 200)["items"].([]any)[0].(map[string]any)
			if p["markdown"] != "Solar project revenue" || p["summary_state"] != "completed" {
				t.Fatal(p)
			}
			saved := call(t, h, "PATCH", path+"/summary", `{"markdown":"Manual edit","version_id":"g0","revision":0}`, 200)
			call(t, h, "PATCH", path+"/summary", `{"markdown":"Outdated","revision":0}`, 409)
			before := calls.Load()
			call(t, h, "POST", path+"/summary/regenerate", fmt.Sprintf(`{"language":"pl","revision":%.0f}`, saved["summary_revision"]), 202)
			process()
			current := call(t, h, "GET", path, "", 200)
			if current["summary_version_id"] != "g1" || !strings.Contains(current["summary"].(string), "Przychody") || calls.Load() != before+1 {
				t.Fatal(current)
			}
			history := call(t, h, "GET", path+"?summary_version=g0", "", 200)
			if history["summary"] != "Manual edit" || history["warnings"] == nil {
				t.Fatal(history)
			}
		})
	}
}
