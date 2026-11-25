package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

//go:embed openapi.json
var spec []byte

const docsHTML = `<!doctype html><html lang="en"><meta charset=utf-8><title>PDF to Summary API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"><div id="docs"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"./openapi.json",dom_id:"#docs"})</script></html>`

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
func integer(name string, fallback int) int {
	v, err := strconv.Atoi(env(name, strconv.Itoa(fallback)))
	if err != nil || v < 1 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return v
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	opt, err := redis.ParseURL(env("REDIS_URL", "redis://127.0.0.1:6389/0"))
	if err != nil {
		return fmt.Errorf("invalid REDIS_URL")
	}
	db := redis.NewClient(opt)
	defer db.Close()
	root, err := filepath.Abs(env("STORAGE_DIR", "data"))
	if err != nil {
		return err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	s := service{db: db, root: root, model: env("GEMINI_MODEL", "gemini-3.1-flash-lite"), key: os.Getenv("GEMINI_API_KEY"), retention: time.Duration(integer("RETENTION_SECONDS", 86400)) * time.Second, maxBytes: int64(integer("MAX_UPLOAD_BYTES", 1<<30)), maxActive: integer("MAX_ACTIVE_DOCUMENTS", 20)}
	s.uploads = make(chan struct{}, s.maxActive)
	reserve, err := strconv.ParseUint(env("MIN_FREE_DISK_BYTES", "268435456"), 10, 64)
	if err != nil {
		return fmt.Errorf("MIN_FREE_DISK_BYTES must be a non-negative integer")
	}
	s.minFreeBytes = reserve
	s.provider = &gemini{client: &http.Client{Timeout: 90 * time.Second}, db: db, endpoint: "https://generativelanguage.googleapis.com/v1beta", key: s.key, model: s.model, interval: time.Minute / time.Duration(integer("GEMINI_REQUESTS_PER_MINUTE", 5))}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mode := "serve"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "worker":
		s.worker(ctx)
		return nil
	case "serve", "api":
	default:
		return fmt.Errorf("usage: pdf-to-summary [serve|api|worker]")
	}
	done := make(chan struct{})
	if mode == "serve" {
		go func() { defer close(done); s.worker(ctx) }()
	} else {
		close(done)
	}
	server := http.Server{Addr: env("LISTEN_ADDR", "127.0.0.1:8000"), Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Hour, IdleTimeout: 90 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Printf("API listening on %s", server.Addr)
	err = server.ListenAndServe()
	stop()
	<-done
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
