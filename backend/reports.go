package main

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// The expiry score is the deadline used by cleanup. A regeneration removes that
// score until the new generation finishes.
type reportRow struct {
	ID          string  `json:"id"`
	Filename    string  `json:"filename"`
	State       string  `json:"state"`
	Pages       int     `json:"page_count"`
	Bytes       int64   `json:"size_bytes"`
	Created     float64 `json:"created_at"`
	Regenerated float64 `json:"last_regenerated_at,omitempty"`
	Deadline    float64 `json:"expires_at"`
}
type workspaceReport struct {
	AsOf       float64        `json:"as_of"`
	Total      int            `json:"total"`
	States     map[string]int `json:"states"`
	Pages      int            `json:"pages"`
	Extracted  int            `json:"extracted_pages"`
	Bytes      int64          `json:"bytes"`
	Scheduled  int            `json:"scheduled"`
	DueSoon    int            `json:"due_in_24h"`
	NextChange float64        `json:"next_change_at,omitempty"`
	Rows       []reportRow    `json:"items"`
}

func (s *service) reports(_ http.ResponseWriter, r *http.Request) (any, error) {
	offset, limit, err := pagination(r, 100)
	if err != nil {
		return nil, err
	}
	ordering, err := parseOrdering(r, "expires_at", "asc")
	if err != nil {
		return nil, err
	}
	result, err := s.snapshot(r.Context())
	if err != nil {
		return nil, err
	}
	rows := slices.DeleteFunc(result.Rows, func(row reportRow) bool { return row.Deadline == 0 })
	result.Rows = ordering.page(rows, offset, limit)
	return result, nil
}

type ordering struct{ field, direction string }

func parseOrdering(r *http.Request, field, direction string) (ordering, error) {
	q := r.URL.Query()
	if q.Has("sort") {
		field = q.Get("sort")
	}
	if q.Has("order") {
		direction = q.Get("order")
	}
	switch field {
	case "expires_at", "created_at", "last_regenerated_at", "status":
	default:
		return ordering{}, problem{422, "Unknown sort field."}
	}
	if direction != "asc" && direction != "desc" {
		return ordering{}, problem{422, "Unknown sort direction."}
	}
	return ordering{field, direction}, nil
}
func (o ordering) page(rows []reportRow, offset, limit int) []reportRow {
	slices.SortFunc(rows, func(a, b reportRow) int {
		var diff int
		switch o.field {
		case "expires_at":
			diff = cmp.Compare(a.Deadline, b.Deadline)
		case "last_regenerated_at":
			if a.Regenerated == 0 && b.Regenerated != 0 {
				return 1
			}
			if b.Regenerated == 0 && a.Regenerated != 0 {
				return -1
			}
			diff = cmp.Compare(a.Regenerated, b.Regenerated)
		case "status":
			diff = cmp.Compare(a.State, b.State)
		default:
			diff = cmp.Compare(a.Created, b.Created)
		}
		if o.direction == "desc" {
			diff = -diff
		}
		if diff != 0 {
			return diff
		}
		return cmp.Compare(a.ID, b.ID)
	})
	start := min(offset, len(rows))
	return rows[start : start+min(limit, len(rows)-start)]
}
func (s *service) snapshot(ctx context.Context) (workspaceReport, error) {
	result := workspaceReport{States: map[string]int{}, Rows: []reportRow{}}
	clock, err := s.db.Time(ctx).Result()
	if err != nil {
		return result, err
	}
	result.AsOf = float64(clock.UnixMilli()) / 1000
	ids, err := s.db.ZRange(ctx, indexKey, 0, -1).Result()
	if err != nil {
		return result, err
	}
	for batch := range slices.Chunk(ids, 32) {
		keys := make([]string, len(batch))
		for i, id := range batch {
			keys[i] = docKey(id)
		}
		var docs *redis.SliceCmd
		var deadlines *redis.FloatSliceCmd
		_, err := s.db.TxPipelined(ctx, func(p redis.Pipeliner) error {
			docs = p.MGet(ctx, keys...)
			deadlines = p.ZMScore(ctx, expiryKey, batch...)
			return nil
		})
		if err != nil {
			return result, err
		}
		for i, raw := range docs.Val() {
			expiry := deadlines.Val()[i]
			if raw == nil || (expiry > 0 && expiry <= result.AsOf) {
				continue
			}
			var item struct {
				reportRow
				Progress Progress `json:"progress"`
				Versions []struct {
					ID      string  `json:"id"`
					Created float64 `json:"created_at"`
				} `json:"summary_versions"`
			}
			if err = json.Unmarshal([]byte(raw.(string)), &item); err != nil {
				return result, err
			}
			result.Total++
			result.States[item.State]++
			result.Extracted += item.Progress.Extracted
			result.Pages += item.Pages
			result.Bytes += item.Bytes
			for _, v := range item.Versions {
				gen, err := strconv.Atoi(strings.TrimPrefix(v.ID, "g"))
				if strings.HasPrefix(v.ID, "g") && err == nil && gen > 0 {
					item.Regenerated = max(item.Regenerated, v.Created)
				}
			}
			item.Deadline = expiry
			result.Rows = append(result.Rows, item.reportRow)
			if expiry <= 0 {
				continue
			}
			result.Scheduled++
			change := expiry
			day := float64((24 * time.Hour).Seconds())
			if expiry <= result.AsOf+day {
				result.DueSoon++
			} else {
				change = expiry - day
			}
			if result.NextChange == 0 || change < result.NextChange {
				result.NextChange = change
			}
		}
	}
	return result, nil
}
