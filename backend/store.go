package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const prefix = "pdf-to-summary:"
const indexKey = prefix + "documents"
const activeKey = prefix + "active"
const queue = prefix + "jobs"
const expiryKey = prefix + "expiry"

// Filter expiration before pagination so totals and items describe the same instant.
const listVisible = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
local offset, limit = tonumber(ARGV[1]), tonumber(ARGV[2])
local result = {0}
for _, id in ipairs(redis.call('ZREVRANGE', KEYS[1], 0, -1)) do
  local expiry = redis.call('ZSCORE', KEYS[2], id)
  if not expiry or tonumber(expiry) > now then
    if result[1] >= offset and #result <= limit then
      table.insert(result, redis.call('GET', ARGV[3] .. id))
    end
    result[1] = result[1] + 1
  end
end
return result`

func docKey(id string) string     { return prefix + id }
func pageKey(id string) string    { return docKey(id) + ":pages" }
func notesKey(d *Document) string { return fmt.Sprintf("%s:notes:%d", docKey(d.ID), d.Generation) }
func idemKey(key string) string {
	return fmt.Sprintf("%supload:%x", prefix, sha256.Sum256([]byte(key)))
}

type service struct {
	db               *redis.Client
	root, model, key string
	maxBytes         int64
	minFreeBytes     uint64
	maxActive        int
	retention        time.Duration
	provider         *gemini
	uploads          chan struct{}
}

func readDoc(ctx context.Context, db redis.Cmdable, id string) (*Document, error) {
	raw, err := db.Get(ctx, docKey(id)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, missing
	}
	if err != nil {
		return nil, err
	}
	var d Document
	err = json.Unmarshal(raw, &d)
	return &d, err
}
func (s *service) document(ctx context.Context, id string) (*Document, error) {
	d, err := readDoc(ctx, s.db, id)
	if err == nil && s.expired(d) {
		return nil, missing
	}
	return d, err
}
func (s *service) expired(d *Document) bool {
	return d.Finished != nil && now() >= *d.Finished+s.retention.Seconds()
}

type mutation func(*Document, redis.Pipeliner) error

// The document revision and the worker's lease are checked in the transaction that publishes each checkpoint.
func (s *service) update(ctx context.Context, id, owner string, change mutation, watchKeys ...string) error {
	keys := append([]string{docKey(id)}, watchKeys...)
	lock := docKey(id) + ":lease"
	if owner != "" {
		keys = append(keys, lock)
	}
	for ctx.Err() == nil {
		err := s.db.Watch(ctx, func(tx *redis.Tx) error {
			if owner != "" {
				token, err := tx.Get(ctx, lock).Result()
				if errors.Is(err, redis.Nil) || err == nil && token != owner {
					return lost
				}
				if err != nil {
					return err
				}
			}
			d, err := readDoc(ctx, tx, id)
			if err != nil {
				return err
			}
			if s.expired(d) {
				return missing
			}
			_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
				if err := change(d, p); err != nil {
					return err
				}
				raw, err := json.Marshal(d)
				if err != nil {
					return err
				}
				p.Set(ctx, docKey(id), raw, 0)
				publishChange(ctx, p, "updated", id)
				return nil
			})
			return err
		}, keys...)
		if !errors.Is(err, redis.TxFailedErr) {
			return err
		}
	}
	return ctx.Err()
}
func (s *service) reused(ctx context.Context, key, name, parser, lang string) (string, error) {
	if key == "" {
		return "", nil
	}
	id, err := s.db.Get(ctx, idemKey(key)).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	d, err := s.document(ctx, id)
	if errors.Is(err, missing) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if d.Filename != name || d.Parser != parser || d.OriginalLanguage != lang {
		return "", problem{409, "This upload key was already used with different options."}
	}
	return id, nil
}
func (s *service) register(ctx context.Context, d *Document, key string) (string, error) {
	keys := []string{activeKey}
	if key != "" {
		keys = append(keys, idemKey(key))
	}
	for ctx.Err() == nil {
		var existing string
		err := s.db.Watch(ctx, func(tx *redis.Tx) error {
			if key != "" {
				var err error
				existing, err = s.reused(ctx, key, d.Filename, d.Parser, d.Language)
				if err != nil || existing != "" {
					return err
				}
			}
			count, err := tx.SCard(ctx, activeKey).Result()
			if err != nil {
				return err
			}
			if count >= int64(s.maxActive) {
				return capacity
			}
			raw, err := json.Marshal(d)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
				p.Set(ctx, docKey(d.ID), raw, 0)
				publishChange(ctx, p, "created", d.ID)
				p.SAdd(ctx, activeKey, d.ID)
				p.ZAdd(ctx, indexKey, redis.Z{Score: d.Created, Member: d.ID})
				p.XAdd(ctx, &redis.XAddArgs{Stream: queue, Values: fields{"id": d.ID}})
				if key != "" {
					p.Set(ctx, idemKey(key), d.ID, s.retention+2*time.Hour)
				}
				return nil
			})
			return err
		}, keys...)
		if !errors.Is(err, redis.TxFailedErr) {
			return existing, err
		}
	}
	return "", ctx.Err()
}
func (s *service) pages(ctx context.Context, d *Document, offset, limit int) ([]Page, error) {
	items := []Page{}
	keys := []string{}
	for n := offset + 1; n <= d.Count && len(keys) < limit; n++ {
		keys = append(keys, strconv.Itoa(n))
	}
	if len(keys) == 0 {
		return items, nil
	}
	vals, err := s.db.HMGet(ctx, pageKey(d.ID), keys...).Result()
	if err != nil {
		return nil, err
	}
	notes, err := s.db.HMGet(ctx, notesKey(d), keys...).Result()
	if err != nil {
		return nil, err
	}
	for i, v := range vals {
		p := Page{Number: offset + i + 1, Extraction: "pending", Summary: "pending"}
		if v != nil {
			if err := json.Unmarshal([]byte(v.(string)), &p); err != nil {
				return nil, err
			}
		}
		if notes[i] != nil {
			if notes[i] == "" {
				p.Summary = "failed"
			} else {
				p.Summary = "completed"
			}
		}
		items = append(items, p)
	}
	return items, nil
}
func (s *service) cleanup(ctx context.Context) error {
	ids, err := s.db.ZRangeByScore(ctx, expiryKey, &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatFloat(now(), 'f', 3, 64), Count: 50}).Result()
	if err != nil {
		return err
	}
	for _, id := range ids {
		err = s.db.Watch(ctx, func(tx *redis.Tx) error {
			d, err := readDoc(ctx, tx, id)
			if err != nil {
				return err
			}
			if !s.expired(d) {
				return nil
			}
			_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
				p.Del(ctx, docKey(id), pageKey(id))
				for g := 0; g <= d.Generation; g++ {
					p.Del(ctx, fmt.Sprintf("%s:notes:%d", docKey(id), g))
				}
				p.ZRem(ctx, indexKey, id)
				p.ZRem(ctx, expiryKey, id)
				publishChange(ctx, p, "deleted", id)
				return nil
			})
			if err == nil {
				if e := os.RemoveAll(filepath.Join(s.root, id)); e != nil {
					log.Print(e)
				}
			}
			return err
		}, docKey(id))
		if err != nil && !errors.Is(err, redis.TxFailedErr) {
			return err
		}
	}
	return nil
}
