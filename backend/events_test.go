package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/redis/go-redis/v9"
)

func TestDocumentEvents(t *testing.T) {
	s := testService(t)
	server := httptest.NewServer(s.routes())
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	check := func(kind, id, state string) {
		t.Helper()
		var event documentEvent
		if err := wsjson.Read(ctx, conn, &event); err != nil {
			t.Fatal(err)
		}
		if event != (documentEvent{kind, id, state}) {
			t.Fatalf("unexpected event: %+v", event)
		}
	}
	check("sync", "", "")
	id := randomID()
	if _, err = s.register(ctx, &Document{ID: id, State: "queued"}, ""); err != nil {
		t.Fatal(err)
	}
	check("created", id, "queued")
	if err = s.update(ctx, id, "", func(d *Document, p redis.Pipeliner) error {
		past := now() - s.retention.Seconds() - 1
		d.Finished = &past
		d.State = "completed"
		p.ZAdd(ctx, expiryKey, redis.Z{Member: id, Score: past})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	check("updated", id, "completed")
	if err = s.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	check("deleted", id, "")
}
