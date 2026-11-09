package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"testing"
	"time"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
)

func warmBenchmarkReview(authored bool) review.Object {
	digest := func(text string) string { sum := sha256.Sum256([]byte(text)); return hex.EncodeToString(sum[:]) }
	document := func(after bool) review.Object {
		r := fixtureReview()
		scenes, nodes, edges, files := []any{}, []any{}, []any{}, []any{}
		for scene := 0; scene < 4; scene++ {
			sid := fmt.Sprintf("scene-%d", scene)
			scenes = append(scenes, review.Object{"id": sid, "title": sid, "description": "Fixed prewarm benchmark"})
			for i := 0; i < 18; i++ {
				id := fmt.Sprintf("%s-node-%02d", sid, i)
				position := review.Object{"x": 0, "y": 0}
				if authored {
					position["y"] = i * 220
				}
				evidence := []any{}
				if i < 4 {
					path := fmt.Sprintf("scene-%d-source-%d.go", scene, i)
					code := fmt.Sprintf("func scene%dstep%d() { return %t }", scene, i, after)
					files = append(files, review.Object{"path": path, "sha256": digest(code + "\n")})
					evidence = append(evidence, review.Object{"path": path, "symbol": "flow", "startLine": 1, "endLine": 1, "digest": digest(code), "code": code})
				}
				nodes = append(nodes, review.Object{"id": id, "sceneId": sid, "title": fmt.Sprintf("Step %d", i), "kind": "action", "summary": "Validate and continue", "detail": "", "input": "", "output": "", "position": position, "evidence": evidence})
				if i > 0 {
					edges = append(edges, review.Object{"id": fmt.Sprintf("%s-edge-%02d", sid, i), "sceneId": sid, "source": fmt.Sprintf("%s-node-%02d", sid, i-1), "target": id, "label": "continue", "detail": ""})
				}
			}
		}
		r["scenes"], r["nodes"], r["edges"] = scenes, nodes, edges
		raw, _ := json.Marshal(files)
		snapshot := objectForComputation(r["snapshot"])
		snapshot["files"], snapshot["fingerprint"] = files, digest(string(raw))
		return r
	}
	before, after := document(false), document(true)
	after["baseline"] = before
	return after
}

func BenchmarkWarmSession(b *testing.B) {
	for _, authored := range []bool{true, false} {
		b.Run(fmt.Sprintf("authored-%t", authored), func(b *testing.B) {
			store := review.NewStore(b.TempDir())
			defer store.Close()
			state, err := store.Create(warmBenchmarkReview(authored), "current", nil)
			if err != nil {
				b.Fatal(err)
			}
			s := &Server{store: store}
			b.ReportAllocs()
			var stats precompute.Stats
			for b.Loop() {
				s.derived = precompute.NewEngine("")
				s.warmSession(b.Context(), textForComputation(state["id"]))
				stats = s.derived.Stats()
				s.derived.Close()
			}
			b.ReportMetric(float64(stats.Computations), "jobs/op")
			b.ReportMetric(float64(stats.PeakActive), "max-workers")
		})
	}
}

func TestWarmIndependentJobsOverlap(t *testing.T) {
	if runtime.GOMAXPROCS(0) < 3 {
		t.Skip("requires two prewarm workers plus capacity for interactive requests")
	}
	store := review.NewStore(t.TempDir())
	defer store.Close()
	state, err := store.Create(warmBenchmarkReview(false), "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store, derived: precompute.NewEngine("")}
	defer s.derived.Close()
	start := time.Now()
	s.warmSession(t.Context(), textForComputation(state["id"]))
	stats := s.derived.Stats()
	t.Logf("warm_ms=%.3f jobs=%d peak_active=%d", float64(time.Since(start))/float64(time.Millisecond), stats.Computations, stats.PeakActive)
	if stats.Computations != 40 {
		t.Fatalf("expected 40 distinct text/structure/layout jobs, got %d", stats.Computations)
	}
	if stats.Failures != 0 {
		t.Fatalf("prewarming silently failed: %+v", stats)
	}
	if stats.PeakActive < 2 {
		t.Fatal("independent diff/layout prewarm jobs still run one at a time")
	}
	if stats.PeakActive > 3 {
		t.Fatal("prewarming occupied all four compute workers")
	}
	s.warmSession(t.Context(), textForComputation(state["id"]))
	if s.derived.Stats().Computations != stats.Computations {
		t.Fatal("prewarming did not retain all computed artifacts")
	}
}

func TestWarmSessionCancellationStopsScheduling(t *testing.T) {
	store := review.NewStore(t.TempDir())
	defer store.Close()
	state, err := store.Create(warmBenchmarkReview(false), "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store, derived: precompute.NewEngine("")}
	defer s.derived.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { s.warmSession(ctx, textForComputation(state["id"])); close(done) }()
	deadline := time.Now().Add(time.Second)
	for s.derived.Stats().Computations < 18 {
		if time.Now().After(deadline) {
			t.Fatal("warm work did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancellation left warm scheduling blocked")
	}
}
