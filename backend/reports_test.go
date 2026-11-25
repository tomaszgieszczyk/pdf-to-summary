package main

import (
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRetentionOnRegeneration(t *testing.T) {
	s := testService(t)
	s.retention = 7 * 24 * time.Hour
	ctx := t.Context()
	id := randomID()
	initial := now() - 3600
	oldDeadline := initial + s.retention.Seconds()
	doc := Document{ID: id, State: "completed", Created: initial, Finished: &initial, Progress: Progress{Extracted: 1}, Versions: []Version{{ID: "g0", Created: initial, Text: "First version"}}}
	if _, err := s.register(ctx, &doc, ""); err != nil {
		t.Fatal(err)
	}
	// A document created before expires_at was added only has the Redis score.
	if err := s.db.ZAdd(ctx, expiryKey, redis.Z{Member: id, Score: oldDeadline}).Err(); err != nil {
		t.Fatal(err)
	}
	h := s.routes()
	path := "/documents/" + id + "/summary/regenerate"
	call(t, h, "POST", path, `{"language":"pl","revision":0}`, 202)
	if err := s.db.ZScore(ctx, expiryKey, id).Err(); !errors.Is(err, redis.Nil) {
		t.Fatalf("active deadline: %v", err)
	}
	w := work{s: s, ctx: ctx, id: id, job: "1-0"}
	if err := w.finish("", "", errors.New("provider error")); err != nil {
		t.Fatal(err)
	}
	if got := s.db.ZScore(ctx, expiryKey, id).Val(); got != oldDeadline {
		t.Fatalf("failed regeneration deadline %v, want %v", got, oldDeadline)
	}
	call(t, h, "POST", path, `{"language":"en","revision":2}`, 202)
	if err := w.finish("New version", "", nil); err != nil {
		t.Fatal(err)
	}
	report, err := s.snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.Total != 1 || report.Scheduled != 1 || report.DueSoon != 0 || report.States["completed"] != 1 {
		t.Fatal(report)
	}
	row := report.Rows[0]
	if row.Regenerated <= initial || row.Deadline <= oldDeadline || math.Abs(row.Deadline-row.Regenerated-s.retention.Seconds()) > .001 {
		t.Fatal(row)
	}
}

func TestExpiryReportOrderingAndSourceRanges(t *testing.T) {
	s := testService(t)
	h := s.routes()
	ctx := t.Context()
	result := call(t, h, "POST", "/documents?filename=file.pdf", "%PDF-1.4", 202, "Content-Type", "application/pdf")
	id := result["id"].(string)
	req := httptest.NewRequest(http.MethodGet, "/documents/"+id+"/source", nil)
	req.Header.Set("Range", "bytes=0-3")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 206 || rr.Body.String() != "%PDF" || rr.Header().Get("Content-Type") != "application/pdf" {
		t.Fatal(rr)
	}
	older := randomID()
	oldTime := now() - 3600
	d := Document{ID: older, State: "partial", Finished: &oldTime, Created: oldTime, Versions: []Version{{ID: "g1", Created: oldTime}}}
	if _, err := s.register(ctx, &d, ""); err != nil {
		t.Fatal(err)
	}
	s.db.ZAdd(ctx, expiryKey, redis.Z{Member: older, Score: now() + 300})
	report := call(t, h, "GET", "/reports", "", 200)
	if report["total"] != float64(2) || report["scheduled"] != float64(1) || report["due_in_24h"] != float64(1) {
		t.Fatal(report)
	}
	for _, test := range []struct{ order, want string }{
		{"sort=created_at&order=asc", older}, {"sort=created_at&order=desc", id}, {"sort=status&order=asc", older},
		{"sort=last_regenerated_at&order=desc", older}, {"sort=last_regenerated_at&order=asc&offset=1", id},
	} {
		got := call(t, h, "GET", "/documents?limit=1&"+test.order, "", 200)["items"].([]any)
		if len(got) != 1 || got[0].(map[string]any)["id"] != test.want {
			t.Fatal(test, got)
		}
	}
	call(t, h, "GET", "/reports?order=bogus", "", 422)
	s.db.ZAdd(ctx, expiryKey, redis.Z{Member: older, Score: now() - 1})
	report = call(t, h, "GET", "/reports", "", 200)
	if report["total"] != float64(1) || report["scheduled"] != float64(0) {
		t.Fatal(report)
	}
}
