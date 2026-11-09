package precompute

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func cachePayload(key string) []byte {
	raw, _ := json.Marshal(map[string]any{"schemaVersion": 1, "algorithm": "test-v1", "key": key, "value": 42})
	return raw
}

func TestSharedWorkCancellationAndDiskRestart(t *testing.T) {
	directory := t.TempDir()
	engine := NewEngine(directory)
	defer engine.Close()
	key := artifactKey("test-v1", "shared")
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	compute := func(ctx context.Context) ([]byte, error) {
		calls.Add(1)
		close(started)
		select {
		case <-release:
			return cachePayload(key), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, _, err := engine.get(ctx, key, 16, compute); first <- err }()
	<-started
	second := make(chan error, 1)
	go func() {
		raw, _, err := engine.get(context.Background(), key, 16, compute)
		if err == nil && !bytes.Equal(raw, cachePayload(key)) {
			err = errors.New("wrong shared result")
		}
		second <- err
	}()
	deadline := time.Now().Add(time.Second)
	for engine.Stats().Shared == 0 {
		if time.Now().After(deadline) {
			t.Fatal("second subscriber never joined shared work")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatal(err)
	}
	close(release)
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate work", calls.Load())
	}
	raw, status, err := engine.get(context.Background(), key, 16, compute)
	if err != nil || status != "memory" {
		t.Fatal(status, err)
	}
	raw[0] = '!'
	again, _, err := engine.get(context.Background(), key, 16, compute)
	if err != nil || !bytes.Equal(again, cachePayload(key)) {
		t.Fatal("caller changed cached bytes", err)
	}
	engine.Close()
	next := NewEngine(directory)
	defer next.Close()
	_, status, err = next.get(context.Background(), key, 16, func(context.Context) ([]byte, error) {
		t.Error("recomputed persisted artifact")
		return nil, errors.New("unexpected")
	})
	if err != nil || status != "disk" || next.Stats().Computations != 0 {
		t.Fatal(status, err, next.Stats())
	}
}

func TestCrashTemporaryCleanupPreservesActiveAndUnknownFiles(t *testing.T) {
	directory := t.TempDir()
	prefix := "artifact-v1-" + strings.Repeat("a", 64) + ".json."
	dead := prefix + "2147483647." + strings.Repeat("A", 26) + ".tmp"
	active := prefix + strconv.Itoa(os.Getpid()) + "." + strings.Repeat("B", 26) + ".tmp"
	unknown := prefix + "unknown.tmp"
	for _, name := range []string{dead, active, unknown} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	engine := NewEngine(directory)
	defer engine.Close()
	if _, err := os.Stat(filepath.Join(directory, dead)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("dead owner's temporary artifact survived startup", err)
	}
	for _, name := range []string{active, unknown} {
		if raw, err := os.ReadFile(filepath.Join(directory, name)); err != nil || string(raw) != "preserve" {
			t.Fatal("cleanup touched active or unknown file", name, err)
		}
	}
}

func TestCorruptOrUnwritableCacheDoesNotLoseResult(t *testing.T) {
	directory := t.TempDir()
	key := artifactKey("test-v1", "corrupt")
	engine := NewEngine(directory)
	if err := os.WriteFile(engine.diskPath(key), []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _, err := engine.get(context.Background(), key, 16, func(context.Context) ([]byte, error) { return cachePayload(key), nil })
	if err != nil || !bytes.Equal(raw, cachePayload(key)) || engine.Stats().DiskErrors == 0 {
		t.Fatal(err, engine.Stats())
	}
	engine.Close()
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	broken := NewEngine(file)
	defer broken.Close()
	if _, _, err := broken.get(context.Background(), key, 16, func(context.Context) ([]byte, error) { return cachePayload(key), nil }); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(file); string(raw) != "preserve" {
		t.Fatal("cache touched unrelated file")
	}
	if broken.Stats().DiskErrors == 0 {
		t.Fatal("failed disk cache was not recorded")
	}
}

func TestWorkerBoundsPanicRecoveryAndShutdown(t *testing.T) {
	engine := NewEngine("")
	var active, peak atomic.Int32
	started := make(chan struct{}, 16)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := engine.get(context.Background(), artifactKey("wait", i), 16, func(ctx context.Context) ([]byte, error) {
				n := active.Add(1)
				defer active.Add(-1)
				for old := peak.Load(); n > old; old = peak.Load() {
					if peak.CompareAndSwap(old, n) {
						break
					}
				}
				started <- struct{}{}
				<-ctx.Done()
				return nil, ctx.Err()
			})
			if err == nil {
				t.Error("shutdown completed as success")
			}
		}(i)
	}
	<-started
	closed := make(chan struct{})
	go func() { engine.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown leaked workers")
	}
	wg.Wait()
	if peak.Load() > 4 || engine.Stats().InFlight != 0 {
		t.Fatal(peak.Load(), engine.Stats())
	}
	next := NewEngine("")
	defer next.Close()
	if _, _, err := next.get(context.Background(), artifactKey("panic", 1), 1, func(context.Context) ([]byte, error) { panic("test") }); err == nil {
		t.Fatal("panic escaped as success")
	}
	key := artifactKey("after-panic", 1)
	if _, _, err := next.get(context.Background(), key, 1, func(context.Context) ([]byte, error) { return cachePayload(key), nil }); err != nil {
		t.Fatal("worker did not recover", err)
	}
}

func TestInputBudgetAndOwnedDiskPruning(t *testing.T) {
	engine := NewEngine(t.TempDir())
	defer engine.Close()
	if _, _, err := engine.get(context.Background(), "large", inputBudget+1, func(context.Context) ([]byte, error) { t.Error("oversize job ran"); return nil, nil }); err != ErrBusy {
		t.Fatal(err)
	}
	unknown := filepath.Join(engine.cacheDir, "preserve.json")
	if err := os.WriteFile(unknown, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxDiskEntries+2; i++ {
		if err := os.WriteFile(engine.diskPath(artifactKey("prune", i)), []byte("owned"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	engine.pruneDisk()
	entries, err := os.ReadDir(engine.cacheDir)
	if err != nil || len(entries) != maxDiskEntries+1 {
		t.Fatal(len(entries), err)
	}
	if raw, err := os.ReadFile(unknown); err != nil || string(raw) != "preserve" {
		t.Fatal("pruning deleted unrelated data", err)
	}
}

func TestStructureWorkersLeaveOrdinaryQueueAvailable(t *testing.T) {
	engine := NewEngine("")
	defer engine.Close()
	workers := min(2, max(1, runtime.GOMAXPROCS(0)))
	started, release := make(chan struct{}, workers), make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := artifactKey("heavy", i)
			_, _, err := engine.getStructure(t.Context(), key, 1, func(ctx context.Context) ([]byte, error) {
				deadline, _ := ctx.Deadline()
				if remaining := time.Until(deadline); remaining < 14*time.Second || remaining > 15*time.Second {
					t.Error("wrong structure worker deadline", remaining)
				}
				started <- struct{}{}
				select {
				case <-release:
					return cachePayload(key), nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			})
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	defer func() { close(release); wg.Wait() }()
	for i := 0; i < workers; i++ {
		<-started
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if _, _, err := engine.Diff(ctx, "one", "two", "txt"); err != nil {
		t.Fatal("structure work blocked diff", err)
	}
	if _, _, err := engine.Layout(ctx, LayoutInput{Nodes: []PlanNode{{ID: "one", Kind: "action"}}, Edges: []PlanEdge{}}); err != nil {
		t.Fatal("structure work blocked layout", err)
	}
	key := artifactKey("ordinary-deadline", 1)
	if _, _, err := engine.get(ctx, key, 1, func(ctx context.Context) ([]byte, error) {
		deadline, _ := ctx.Deadline()
		if remaining := time.Until(deadline); remaining < 3*time.Second || remaining > 4*time.Second {
			t.Error("ordinary worker deadline changed", remaining)
		}
		return cachePayload(key), nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestStructureQueueSharedBudgetCancellationAndShutdown(t *testing.T) {
	engine := NewEngine("")
	defer engine.Close()
	started, release := make(chan struct{}), make(chan struct{})
	key := artifactKey("structure-shared", 1)
	ctx, cancel := context.WithCancel(t.Context())
	first, second := make(chan error, 1), make(chan error, 1)
	go func() {
		_, _, err := engine.getStructure(ctx, key, inputBudget-8, func(ctx context.Context) ([]byte, error) {
			close(started)
			select {
			case <-release:
				return cachePayload(key), nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
		first <- err
	}()
	<-started
	go func() {
		_, _, err := engine.getStructure(t.Context(), key, inputBudget-8, func(context.Context) ([]byte, error) {
			t.Error("shared structure computation ran twice")
			return nil, nil
		})
		second <- err
	}()
	deadline := time.Now().Add(time.Second)
	for engine.Stats().Shared == 0 {
		if time.Now().After(deadline) {
			t.Fatal("structure subscriber did not share work")
		}
		time.Sleep(time.Millisecond)
	}
	if _, _, err := engine.get(t.Context(), artifactKey("ordinary-budget", 1), 16, nil); err != ErrBusy {
		t.Fatal("structure and ordinary input budgets are not shared", err)
	}
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatal(err)
	}
	close(release)
	if err := <-second; err != nil {
		t.Fatal("one subscriber cancelled shared structure work", err)
	}
	engine.mu.Lock()
	remaining := engine.inputBytes
	engine.mu.Unlock()
	if remaining != 0 {
		t.Fatal("input budget not released", remaining)
	}
	workers := min(2, max(1, runtime.GOMAXPROCS(0)))
	startedJobs := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers+cap(engine.structureQueue)+2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := engine.getStructure(t.Context(), artifactKey("closing-structure", i), 1, func(ctx context.Context) ([]byte, error) {
				startedJobs <- struct{}{}
				<-ctx.Done()
				return nil, ctx.Err()
			})
			if err != ErrClosed && err != ErrBusy {
				t.Error("queued structure job escaped close", err)
			}
		}(i)
	}
	for i := 0; i < workers; i++ {
		<-startedJobs
	}
	engine.Close()
	wg.Wait()
	engine.mu.Lock()
	remaining = engine.inputBytes
	engine.mu.Unlock()
	if stats := engine.Stats(); remaining != 0 || stats.InFlight != 0 || stats.Active != 0 || len(engine.structureQueue) != 0 || stats.PeakActive > workers {
		t.Fatal("structure shutdown leaked jobs or exceeded worker bound", remaining, stats)
	}
}
