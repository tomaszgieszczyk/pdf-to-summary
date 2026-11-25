package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/redis/go-redis/v9"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type gemini struct {
	client               *http.Client
	db                   *redis.Client
	endpoint, key, model string
	interval             time.Duration
}

func wait(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (g *gemini) slot(ctx context.Context) error {
	for {
		ok, err := g.db.SetNX(ctx, prefix+"provider-slot", "1", g.interval).Result()
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		delay, err := g.db.PTTL(ctx, prefix+"provider-slot").Result()
		if err != nil {
			return err
		}
		if err = wait(ctx, max(delay, 10*time.Millisecond)); err != nil {
			return err
		}
	}
}

type providerError struct {
	status int
	retry  time.Duration
}

func (e providerError) Error() string { return fmt.Sprintf("Gemini returned HTTP %d", e.status) }
func (g *gemini) generate(ctx context.Context, prompt string, file []byte) (string, error) {
	if g.key == "" {
		return "", fmt.Errorf("GEMINI_API_KEY is not configured")
	}
	parts := []fields{{"text": prompt}}
	if file != nil {
		parts = append(parts, fields{"inlineData": fields{"mimeType": "application/pdf", "data": base64.StdEncoding.EncodeToString(file)}})
	}
	body, err := json.Marshal(fields{"contents": []fields{{"role": "user", "parts": parts}}})
	if err != nil {
		return "", err
	}
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		if err = g.slot(ctx); err != nil {
			return "", err
		}
		var text string
		text, last = g.request(ctx, body)
		if last == nil {
			return text, nil
		}
		delay := time.Second << attempt
		if e, ok := last.(providerError); ok {
			if e.status != 429 && e.status != 408 && e.status < 500 {
				return "", e
			}
			delay = max(delay, e.retry)
		}
		if attempt < 4 {
			if err = wait(ctx, delay); err != nil {
				return "", err
			}
		}
	}
	return "", last
}
func (g *gemini) request(ctx context.Context, body []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.endpoint+"/models/"+url.PathEscape(g.model)+":generateContent", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", g.key)
	resp, err := g.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		n, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return "", providerError{resp.StatusCode, time.Duration(min(max(n, 0), 300)) * time.Second}
	}
	var data struct {
		Candidates []struct {
			FinishReason string
			Content      struct {
				Parts []struct {
					Text    string
					Thought bool
				}
			}
		}
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&data); err != nil {
		return "", err
	}
	if len(data.Candidates) == 0 || data.Candidates[0].FinishReason != "STOP" {
		return "", fmt.Errorf("Gemini returned no complete result")
	}
	var b strings.Builder
	for _, part := range data.Candidates[0].Content.Parts {
		if !part.Thought {
			b.WriteString(part.Text)
		}
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		return "", fmt.Errorf("Gemini returned an empty response")
	}
	return text, nil
}
