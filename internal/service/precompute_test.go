package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
)

func precomputeSourceFixture(code string) review.Object {
	r := fixtureReview()
	digest := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	files := []any{review.Object{"path": "saved.go", "sha256": digest(code + "\n")}}
	manifest, _ := json.Marshal(files)
	snap := objectForComputation(r["snapshot"])
	snap["files"], snap["fingerprint"] = files, digest(string(manifest))
	objectForComputation(arrayForComputation(r["nodes"])[0])["evidence"] = []any{review.Object{"path": "saved.go", "symbol": "run", "startLine": 1, "endLine": strings.Count(code, "\n") + 1, "code": code, "digest": digest(code)}}
	return r
}

func computationRequest(t *testing.T, s *Server, path string, input any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "http://review.test"+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://review.test")
	response := httptest.NewRecorder()
	if !s.servePrecompute(response, req, path) {
		t.Fatal("unhandled precompute route")
	}
	return response
}

func TestPrecomputeSavedSnapshotsCacheAndValidation(t *testing.T) {
	directory := t.TempDir()
	s := &Server{store: review.NewStore(directory), derived: precompute.NewEngine(filepath.Join(directory, "derived"))}
	defer s.store.Close()
	defer func() { s.derived.Close() }()
	before, after := precomputeSourceFixture("run(😀, 1)"), precomputeSourceFixture("run(😀, 2)")
	after["baseline"] = before
	state, err := s.store.Create(after, "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	id := textForComputation(state["id"])
	path := "/api/review-sessions/" + id + "/precompute/diff"
	ref := func(r review.Object) evidenceReference {
		return referenceForWarm(objectForComputation(arrayForComputation(objectForComputation(arrayForComputation(r["nodes"])[0])["evidence"])[0]))
	}
	input := diffRequest{BeforeSnapshot: snapshotSelector{Kind: "baseline"}, AfterSnapshot: snapshotSelector{Kind: "round", Round: 1}, Before: ref(before), After: ref(after)}
	response := computationRequest(t, s, path, input)
	if response.Code != 200 || response.Header().Get("X-Logic-Margin-Cache") != "miss" {
		t.Fatal(response.Code, response.Body.String(), response.Header())
	}
	var first precompute.DiffResult
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Coordinate != "utf16" || first.Before.Digest != input.Before.Digest || len(first.Changes) != 1 || first.Changes[0].FromA != 8 {
		t.Fatal(first)
	}
	originalSignature := warmSignature(state)
	saved, err := s.store.Mutate(id, review.Object{"revision": after["revision"], "fingerprint": objectForComputation(after["snapshot"])["fingerprint"], "round": 1, "expectedVersion": state["version"], "mutations": []any{review.Object{"kind": "add-comment", "comment": review.Object{"id": "c1", "body": "Review note", "targets": []any{review.Object{"kind": "node", "id": "entry"}}, "status": "open", "createdAt": "2026-11-09T00:00:00Z", "revision": after["revision"]}}}}, "current")
	if err != nil {
		t.Fatal(err)
	}
	if warmSignature(saved) != originalSignature {
		t.Fatal("comment invalidated warm signature")
	}
	response = computationRequest(t, s, path, input)
	var cached precompute.DiffResult
	_ = json.Unmarshal(response.Body.Bytes(), &cached)
	if response.Code != 200 || response.Header().Get("X-Logic-Margin-Cache") != "memory" || cached.Key != first.Key {
		t.Fatal(response.Code, response.Body.String())
	}
	s.derived.Close()
	s.derived = precompute.NewEngine(filepath.Join(directory, "derived"))
	response = computationRequest(t, s, path, input)
	if response.Code != 200 || response.Header().Get("X-Logic-Margin-Cache") != "disk" {
		t.Fatal(response.Code, response.Body.String(), response.Header())
	}
	for _, item := range []struct {
		name   string
		edit   func(*diffRequest)
		status int
	}{
		{"wrong digest", func(r *diffRequest) { r.After.Digest = strings.Repeat("0", 64) }, 409},
		{"wrong snapshot", func(r *diffRequest) { r.AfterSnapshot.Round = 2 }, 404},
		{"wrong side", func(r *diffRequest) { r.BeforeSnapshot = snapshotSelector{Kind: "round", Round: 1} }, 409},
		{"invalid selector", func(r *diffRequest) { r.BeforeSnapshot.Round = 1 }, 400},
	} {
		t.Run(item.name, func(t *testing.T) {
			bad := input
			item.edit(&bad)
			r := computationRequest(t, s, path, bad)
			if r.Code != item.status {
				t.Fatal(r.Code, r.Body.String())
			}
		})
	}
	unknown := computationRequest(t, s, path, map[string]any{"beforeSnapshot": input.BeforeSnapshot, "afterSnapshot": input.AfterSnapshot, "before": input.Before, "after": input.After, "code": "untrusted source"})
	if unknown.Code != 400 {
		t.Fatal("accepted uploaded source", unknown.Code)
	}
	if r := computationRequest(t, s, "/api/review-sessions/00000000-0000-4000-8000-000000000000/precompute/diff", input); r.Code != 404 {
		t.Fatal("cache bypassed owning session", r.Code)
	}
}

func TestPrecomputeLayoutDimensionsAndComparisonKeys(t *testing.T) {
	s := &Server{store: review.NewStore(t.TempDir()), derived: precompute.NewEngine("")}
	defer s.store.Close()
	defer s.derived.Close()
	state, err := s.store.Create(fixtureReview(), "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/review-sessions/" + textForComputation(state["id"]) + "/precompute/layout"
	input := precompute.LayoutInput{Nodes: []precompute.PlanNode{{ID: "entry", Kind: "action", Title: "Entry"}}, Edges: []precompute.PlanEdge{}, Sizes: []precompute.Size{}}
	key := func(input precompute.LayoutInput) string {
		t.Helper()
		r := computationRequest(t, s, path, input)
		if r.Code != 200 {
			t.Fatal(r.Code, r.Body.String())
		}
		var v precompute.LayoutResult
		if err := json.Unmarshal(r.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		return v.Key
	}
	original := key(input)
	if key(input) != original {
		t.Fatal("identical layout key changed")
	}
	input.Sizes = []precompute.Size{{ID: "entry", Width: 280, Height: 210}}
	sized := key(input)
	if sized == original {
		t.Fatal("dimensions did not invalidate layout")
	}
	input.Reference = &precompute.Graph{Nodes: input.Nodes, Edges: input.Edges}
	if key(input) == sized {
		t.Fatal("comparison did not invalidate layout")
	}
	input.Edges = []precompute.PlanEdge{{ID: "bad", Source: "entry", Target: "missing"}}
	r := computationRequest(t, s, path, input)
	if r.Code == 200 {
		t.Fatal("invalid geometry accepted")
	}
	req := httptest.NewRequest("POST", "http://review.test"+path, strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://outside.test")
	response := httptest.NewRecorder()
	s.servePrecompute(response, req, path)
	if response.Code != 403 {
		t.Fatal("cross origin compute accepted", response.Code)
	}
}
