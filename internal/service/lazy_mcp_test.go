package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"logicmargin/internal/review"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestLazyMCPCatalogAndPerCallResolution(t *testing.T) {
	var calls atomic.Int32
	var backend *Server
	server := NewMCP("0.9.18", func(ctx context.Context) (string, error) {
		calls.Add(1)
		if backend == nil {
			backend = testServer(t)
		}
		return backend.URL, nil
	})
	client := mcp.NewClient(&mcp.Implementation{Name: "lazy-test", Version: "1"}, nil)
	one, two := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := server.Connect(ctx, one, nil); err != nil {
		t.Fatal(err)
	}
	session, err := client.Connect(ctx, two, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != len(reviewTools) {
		t.Fatal(tools, err)
	}
	if calls.Load() != 0 || backend != nil {
		t.Fatal("initialization or catalog eagerly started backend")
	}
	callTool(t, session, "list_reviews", map[string]any{"state": "all"})
	if calls.Load() != 1 {
		t.Fatal("first tool did not resolve backend once")
	}
	backend = testServer(t)
	callTool(t, session, "list_reviews", map[string]any{"state": "all"})
	if calls.Load() != 2 {
		t.Fatal("next call did not resolve replacement backend")
	}
}

func TestLazyMCPFailedDispatchDoesNotRetry(t *testing.T) {
	var calls atomic.Int32
	server := NewMCP("0.9.18", func(context.Context) (string, error) { calls.Add(1); return "", errors.New("backend unavailable") })
	one, two := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if _, err := server.Connect(ctx, one, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "lazy-failure", Version: "1"}, nil).Connect(ctx, two, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "list_reviews"})
	if err != nil || !result.IsError || calls.Load() != 1 {
		t.Fatal(result, err, calls.Load())
	}
}

func TestLazyMCPDoesNotReplayLostWriteResponse(t *testing.T) {
	var writes atomic.Int32
	doc := fixtureReview()
	doc["comments"] = []any{review.Object{"id": "c1", "body": "check", "targets": []any{review.Object{"kind": "node", "id": "entry"}}, "status": "open", "createdAt": "2026-11-08T00:00:00Z", "revision": "r1"}}
	current := review.Object{"schemaVersion": 1, "id": "session", "version": 1, "round": 1, "phase": "agent-working", "snapshots": []any{}, "history": []any{}, "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z", "review": doc}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(current)
			return
		}
		writes.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer backend.Close()
	server := NewMCP("0.9.18", func(context.Context) (string, error) { return backend.URL, nil })
	one, two := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if _, err := server.Connect(ctx, one, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "lazy-lost-write", Version: "1"}, nil).Connect(ctx, two, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "reply_review", Arguments: map[string]any{"session_id": "session", "comment_id": "c1", "body": "once"}})
	if err != nil || !result.IsError || writes.Load() != 1 {
		t.Fatal(result, err, writes.Load())
	}
}
