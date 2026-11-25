package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

type fields = map[string]any

//go:embed languages.json
var languageData []byte
var languages map[string]string

func init() {
	if err := json.Unmarshal(languageData, &languages); err != nil {
		panic(err)
	}
}

type Progress struct {
	Prepared   int `json:"prepared_pages"`
	Extracted  int `json:"extracted_pages"`
	Summarized int `json:"summarized_pages"`
}
type Failure struct {
	Task     string `json:"task_id"`
	Stage    string `json:"stage"`
	Message  string `json:"message"`
	Attempts int    `json:"attempts"`
}
type Version struct {
	ID       string   `json:"id"`
	Language string   `json:"language"`
	Model    string   `json:"model"`
	Created  float64  `json:"created_at"`
	Edited   *float64 `json:"edited_at"`
	Revision int      `json:"revision"`
	Text     string   `json:"markdown,omitempty"`
	Override *string  `json:"override,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}
type Document struct {
	ID                string            `json:"id"`
	Filename          string            `json:"filename"`
	Parser            string            `json:"parser"`
	State             string            `json:"state"`
	Created           float64           `json:"created_at"`
	ExpiresAt         *float64          `json:"expires_at,omitempty"`
	Finished          *float64          `json:"finished_at"`
	Size              int64             `json:"size_bytes"`
	Count             int               `json:"page_count"`
	Language          string            `json:"summary_language"`
	OriginalLanguage  string            `json:"upload_summary_language"`
	Pending           string            `json:"pending_summary_language,omitempty"`
	Model             string            `json:"generation_model"`
	Revision          int               `json:"summary_revision"`
	Generation        int               `json:"generation"`
	Versions          []Version         `json:"summary_versions"`
	Progress          Progress          `json:"progress"`
	Warnings          []string          `json:"warnings"`
	Errors            []Failure         `json:"errors"`
	MissingExtraction []int             `json:"missing_extraction_pages"`
	MissingSummary    []int             `json:"missing_summary_pages"`
	Metadata          map[string]string `json:"metadata"`
}
type Page struct {
	TextFormat  string  `json:"text_format,omitempty"`
	MarginNotes string  `json:"margin_notes,omitempty"`
	Warning     string  `json:"warning,omitempty"`
	Number      int     `json:"page"`
	Markdown    *string `json:"markdown"`
	Blank       *bool   `json:"blank"`
	Extraction  string  `json:"extraction_state"`
	Summary     string  `json:"summary_state"`
}

func (p Page) sourceText() string {
	if p.Markdown == nil {
		return ""
	}
	if p.MarginNotes == "" {
		return *p.Markdown
	}
	return *p.Markdown + "\n\n" + p.MarginNotes
}

func (d *Document) terminal() bool {
	return d.State == "completed" || d.State == "partial" || d.State == "failed"
}
func now() float64     { return float64(time.Now().UnixMilli()) / 1000 }
func randomID() string { b := make([]byte, 16); rand.Read(b); return hex.EncodeToString(b) }

type problem struct {
	code    int
	message string
}

func (p problem) Error() string { return p.message }

var missing = problem{404, "Document not found or expired."}
var conflict = problem{409, "The summary changed in another session. Reload before retrying."}
var busy = problem{409, "Document processing is active."}
var capacity = problem{429, "The service is at capacity. Try again later."}
var lost = errors.New("processing lease expired")

func (d *Document) view(selected string) (fields, error) {
	data, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	var out fields
	if err = json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	delete(out, "generation")
	delete(out, "upload_summary_language")
	out["model"] = d.Model
	out["terminal"] = d.terminal()
	if !d.terminal() {
		delete(out, "expires_at")
	}
	out["summary"] = nil
	out["summary_model"] = nil
	out["summary_version_id"] = nil
	out["summary_edited_at"] = nil
	out["summary_version_revision"] = 0
	if d.Pending == "" {
		out["pending_summary_language"] = nil
	}
	if d.Count == 0 {
		out["page_count"] = nil
	}
	versions := make([]Version, 0, len(d.Versions))
	found := false
	for i, v := range d.Versions {
		if selected == v.ID || (selected == "" && i == 0) {
			found = true
			out["summary"] = v.Text
			if v.Override != nil {
				out["summary"] = *v.Override
			}
			out["summary_model"] = v.Model
			out["summary_language"] = v.Language
			out["summary_version_revision"] = v.Revision
			out["summary_version_id"] = v.ID
			out["summary_edited_at"] = v.Edited
			if selected != "" && len(v.Warnings) > 0 {
				out["warnings"] = v.Warnings
			} else if selected != "" {
				out["warnings"] = []string{}
			}
		}
		v.Text = ""
		v.Override = nil
		v.Warnings = nil
		versions = append(versions, v)
	}
	if selected != "" && !found {
		return nil, problem{404, "Summary version not found."}
	}
	out["summary_versions"] = versions
	return out, nil
}
