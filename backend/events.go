package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/redis/go-redis/v9"
)

const documentEvents = prefix + "events"

func publishChange(ctx context.Context, p redis.Pipeliner, kind, id, state string) {
	p.Publish(ctx, documentEvents, kind+":"+id+":"+state)
}

type documentEvent struct {
	Type  string `json:"type"`
	ID    string `json:"id,omitempty"`
	State string `json:"state,omitempty"`
}

func (s *service) events(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx, cancel := context.WithCancel(conn.CloseRead(r.Context()))
	defer cancel()
	sub := s.db.Subscribe(ctx, documentEvents)
	// Closing the subscription also interrupts a blocked Redis read.
	stop := context.AfterFunc(ctx, func() { sub.Close() })
	defer func() { stop(); sub.Close() }()
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				ping, done := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Ping(ping)
				done()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		message, err := sub.Receive(ctx)
		if err != nil {
			return
		}
		var event documentEvent
		switch v := message.(type) {
		case *redis.Subscription:
			// Refresh after the Redis subscription is live, including on reconnect.
			event.Type = "sync"
		case *redis.Message:
			kind, id, ok := strings.Cut(v.Payload, ":")
			if !ok {
				continue
			}
			id, state, _ := strings.Cut(id, ":")
			event = documentEvent{Type: kind, ID: id, State: state}
		default:
			continue
		}
		write, done := context.WithTimeout(ctx, 5*time.Second)
		err = wsjson.Write(write, conn, event)
		done()
		if err != nil {
			return
		}
	}
}
