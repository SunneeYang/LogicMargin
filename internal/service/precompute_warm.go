package service

import (
	"context"
	"encoding/json"
	"runtime"
	"sort"
	"sync"
	"time"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
)

type warmTask struct{ id, signature string }

func (s *Server) scheduleWarm(value any) {
	state, ok := validWarmState(value)
	if !ok {
		return
	}
	id := textForComputation(state["id"])
	signature := warmSignature(state)
	key := warmKey(id, signature)
	s.warmMu.Lock()
	defer s.warmMu.Unlock()
	if s.warmSeen[key] {
		return
	}
	select {
	case s.warmQueue <- warmTask{id, signature}:
		s.warmSeen[key] = true
		s.warmOrder = append(s.warmOrder, key)
		for len(s.warmOrder) > 64 {
			delete(s.warmSeen, s.warmOrder[0])
			s.warmOrder = s.warmOrder[1:]
		}
	default:
	}
}

func (s *Server) warmWorker() {
	defer s.warmWorkers.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case task := <-s.warmQueue:
			if s.ctx.Err() != nil {
				return
			}
			ctx, cancel := context.WithTimeout(s.ctx, 12*time.Second)
			s.warmSession(ctx, task.id)
			cancel()
		}
	}
}

func (s *Server) warmSession(ctx context.Context, id string) {
	state, err := s.store.Get(id, "current")
	if err != nil || ctx.Err() != nil {
		return
	}
	current := objectForComputation(state["review"])
	round := integerForComputation(state["round"])
	comparisons := []review.Object{}
	if baseline, err := s.snapshotForComputation(id, state, snapshotSelector{Kind: "baseline"}); err == nil {
		comparisons = append(comparisons, baseline)
	}
	if round > 1 {
		if previous, err := s.snapshotForComputation(id, state, snapshotSelector{Kind: "round", Round: round - 1}); err == nil {
			comparisons = append(comparisons, previous)
		}
	}
	tasks := []func(){}
	queueLayout := func(input precompute.LayoutInput) {
		tasks = append(tasks, func() { _, _, _ = s.derived.Layout(ctx, input) })
	}
	defer func() { runWarmTasks(ctx, tasks) }()
	for _, before := range comparisons {
		for _, pair := range uniqueWarmPairs(ctx, before, current) {
			if ctx.Err() != nil {
				return
			}
			tasks = append(tasks, func() { _, _, _ = s.derived.Diff(ctx, pair.before, pair.after, pair.language) })
			tasks = append(tasks, func() { _, _, _ = s.derived.Structure(ctx, pair.before, pair.after, pair.language) })
		}
	}
	graphComparisons := comparisons
	for _, raw := range arrayForComputation(state["snapshots"]) {
		info := objectForComputation(raw)
		if integerForComputation(info["round"]) != round {
			continue
		}
		base := integerForComputation(objectForComputation(info["publication"])["baseRound"])
		if base > 0 && base != round-1 {
			if previous, err := s.snapshotForComputation(id, state, snapshotSelector{Kind: "round", Round: base}); err == nil {
				graphComparisons = append(append([]review.Object{}, comparisons...), previous)
			}
		}
	}
	// Optional warming must stay bounded even for reviews too large for layout computation.
	if len(arrayForComputation(current["nodes"])) > 512 || len(arrayForComputation(current["edges"])) > 1024 || len(arrayForComputation(current["scenes"])) > 512 {
		return
	}
	for _, scene := range arrayForComputation(current["scenes"]) {
		if ctx.Err() != nil {
			return
		}
		sceneID := textForComputation(objectForComputation(scene)["id"])
		graph := graphForWarm(current, sceneID)
		if len(graph.Nodes) == 0 {
			continue
		}
		input := precompute.LayoutInput{Nodes: graph.Nodes, Edges: graph.Edges, Sizes: []precompute.Size{}}
		queueLayout(input)
		for _, before := range graphComparisons {
			if ctx.Err() != nil {
				return
			}
			if len(arrayForComputation(before["nodes"])) > 512 || len(arrayForComputation(before["edges"])) > 1024 {
				continue
			}
			original := graphForWarm(before, sceneID)
			input.Reference = &original
			queueLayout(input)
			reverse := precompute.LayoutInput{Nodes: original.Nodes, Edges: original.Edges, Reference: &graph, Sizes: []precompute.Size{}}
			queueLayout(reverse)
		}
	}
}

func runWarmTasks(ctx context.Context, tasks []func()) {
	jobs := make(chan func())
	var workers sync.WaitGroup
	// Leave a compute worker for interactive requests where the CPU limit permits.
	limit := max(1, min(3, runtime.GOMAXPROCS(0)-1))
	for range min(limit, len(tasks)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for task := range jobs {
				if ctx.Err() == nil {
					task()
				}
			}
		}()
	}
queue:
	for _, task := range tasks {
		select {
		case jobs <- task:
		case <-ctx.Done():
			break queue
		}
	}
	close(jobs)
	workers.Wait()
}

type warmReference struct {
	evidence review.Object
	nodes    map[string]bool
}
type warmPair struct{ before, after, language string }

func referencesForWarm(ctx context.Context, document review.Object) map[string][]*warmReference {
	groups := map[string][]*warmReference{}
	seen := map[string]*warmReference{}
	remaining := 4096
	for _, rawNode := range arrayForComputation(document["nodes"]) {
		remaining--
		if ctx.Err() != nil || remaining < 0 {
			return nil
		}
		node := objectForComputation(rawNode)
		for _, raw := range arrayForComputation(node["evidence"]) {
			remaining--
			if ctx.Err() != nil || remaining < 0 {
				// Partial collection cannot prove that a reference has a unique counterpart.
				return nil
			}
			evidence := objectForComputation(raw)
			if _, ok := evidence["code"].(string); !ok {
				continue
			}
			ref := referenceForWarm(evidence)
			encoded, _ := json.Marshal(ref)
			key := string(encoded)
			if previous := seen[key]; previous != nil {
				previous.nodes[textForComputation(node["id"])] = true
				continue
			}
			item := &warmReference{evidence, map[string]bool{textForComputation(node["id"]): true}}
			seen[key] = item
			group, _ := json.Marshal([]string{ref.Path, ref.Symbol})
			groups[string(group)] = append(groups[string(group)], item)
		}
	}
	return groups
}

func uniqueWarmPairs(ctx context.Context, before, after review.Object) []warmPair {
	left, right := referencesForWarm(ctx, before), referencesForWarm(ctx, after)
	if left == nil || right == nil {
		return nil
	}
	keys := make([]string, 0, len(left))
	for key := range left {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := []warmPair{}
	remaining := 65536
	shared := func(a, b *warmReference) (bool, bool) {
		remaining--
		if ctx.Err() != nil || remaining < 0 {
			return false, false
		}
		for id := range a.nodes {
			remaining--
			if ctx.Err() != nil || remaining < 0 {
				return false, false
			}
			if b.nodes[id] {
				return true, true
			}
		}
		return false, true
	}
	for _, key := range keys {
		old, current := left[key], right[key]
		for _, candidate := range old {
			matches := []*warmReference{}
			for _, item := range current {
				match, ok := shared(candidate, item)
				if !ok {
					return pairs
				}
				if match {
					matches = append(matches, item)
					if len(matches) > 1 {
						break
					}
				}
			}
			if len(matches) != 1 {
				continue
			}
			count := 0
			for _, item := range old {
				match, ok := shared(item, matches[0])
				if !ok {
					return pairs
				}
				if match {
					count++
					if count > 1 {
						break
					}
				}
			}
			if count != 1 {
				continue
			}
			pairs = append(pairs, warmPair{textForComputation(candidate.evidence["code"]), textForComputation(matches[0].evidence["code"]), sourceLanguage(textForComputation(matches[0].evidence["path"]))})
		}
	}
	return pairs
}

func graphForWarm(document review.Object, sceneID string) precompute.Graph {
	graph := precompute.Graph{Nodes: []precompute.PlanNode{}, Edges: []precompute.PlanEdge{}}
	number := func(value any) float64 { v, _ := value.(float64); return v }
	for _, raw := range arrayForComputation(document["nodes"]) {
		node := objectForComputation(raw)
		if node["sceneId"] != sceneID {
			continue
		}
		position := objectForComputation(node["position"])
		graph.Nodes = append(graph.Nodes, precompute.PlanNode{ID: textForComputation(node["id"]), Kind: textForComputation(node["kind"]), Title: textForComputation(node["title"]), Summary: textForComputation(node["summary"]), Position: precompute.Point{X: number(position["x"]), Y: number(position["y"])}})
	}
	for _, raw := range arrayForComputation(document["edges"]) {
		edge := objectForComputation(raw)
		if edge["sceneId"] != sceneID {
			continue
		}
		graph.Edges = append(graph.Edges, precompute.PlanEdge{ID: textForComputation(edge["id"]), Source: textForComputation(edge["source"]), Target: textForComputation(edge["target"]), Label: textForComputation(edge["label"])})
	}
	return graph
}
