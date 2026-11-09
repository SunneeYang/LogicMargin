package service

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
)

func TestStructureSavedSourceAndCacheBinding(t *testing.T) {
	directory := t.TempDir()
	s := &Server{store: review.NewStore(directory), derived: precompute.NewEngine(filepath.Join(directory, "derived"))}
	defer s.store.Close()
	defer func() { s.derived.Close() }()
	before := precomputeSourceFixture("func check(n int) bool { return n<10 }")
	after := precomputeSourceFixture("func check(n int) bool {\n return n <= 10\n}")
	after["baseline"] = before
	state, err := s.store.Create(after, "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	id := textForComputation(state["id"])
	path := "/api/review-sessions/" + id + "/precompute/structure"
	ref := func(r review.Object) evidenceReference {
		return referenceForWarm(objectForComputation(arrayForComputation(objectForComputation(arrayForComputation(r["nodes"])[0])["evidence"])[0]))
	}
	input := diffRequest{BeforeSnapshot: snapshotSelector{Kind: "baseline"}, AfterSnapshot: snapshotSelector{Kind: "round", Round: 1}, Before: ref(before), After: ref(after)}
	response := computationRequest(t, s, path, input)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var result precompute.StructureResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Mode != "structural" || result.FormattingOnly || len(result.Highlights.After) != 1 || result.Before.Digest != input.Before.Digest || len(result.Scopes) != 1 {
		t.Fatal(result)
	}
	if response.Header().Get("X-Logic-Margin-Cache") != "miss" {
		t.Fatal(response.Header())
	}
	response = computationRequest(t, s, path, input)
	if response.Code != 200 || response.Header().Get("X-Logic-Margin-Cache") != "memory" {
		t.Fatal(response.Code, response.Header())
	}
	s.derived.Close()
	s.derived = precompute.NewEngine(filepath.Join(directory, "derived"))
	response = computationRequest(t, s, path, input)
	if response.Code != 200 || response.Header().Get("X-Logic-Margin-Cache") != "disk" {
		t.Fatal(response.Code, response.Body.String(), response.Header())
	}
	var persisted precompute.StructureResult
	_ = json.Unmarshal(response.Body.Bytes(), &persisted)
	if persisted.Key != result.Key {
		t.Fatal("restart changed structural key")
	}
	bad := input
	bad.After.Digest = strings.Repeat("0", 64)
	response = computationRequest(t, s, path, bad)
	if response.Code != 409 {
		t.Fatal("structure cache bypassed saved source binding", response.Code)
	}
	bad = input
	bad.BeforeSnapshot = snapshotSelector{Kind: "round", Round: 1}
	response = computationRequest(t, s, path, bad)
	if response.Code != 409 {
		t.Fatal("cross-snapshot source accepted", response.Code)
	}
	response = computationRequest(t, s, "/api/review-sessions/00000000-0000-4000-8000-000000000000/precompute/structure", input)
	if response.Code != 404 {
		t.Fatal("structure cache bypassed owning session", response.Code)
	}
}
