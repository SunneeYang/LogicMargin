package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"logicmargin/internal/review"
)

func warmDocument(count int) review.Object {
	nodes := make([]any, count)
	for i := range nodes {
		nodes[i] = review.Object{"id": fmt.Sprint(i), "evidence": []any{review.Object{"path": "logic.go", "symbol": "flow", "startLine": i + 1, "endLine": i + 1, "digest": fmt.Sprint(i), "code": "saved"}}}
	}
	return review.Object{"nodes": nodes}
}

func TestWarmPairCancellationBudgetAndUniqueness(t *testing.T) {
	small := warmDocument(2)
	if pairs := uniqueWarmPairs(t.Context(), small, small); len(pairs) != 2 {
		t.Fatal("lost unique pairs", len(pairs))
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if pairs := uniqueWarmPairs(ctx, small, small); len(pairs) != 0 {
		t.Fatal("canceled pairing returned work")
	}
	ambiguous := warmDocument(2)
	nodes := arrayForComputation(ambiguous["nodes"])
	objectForComputation(nodes[1])["id"] = "0"
	if pairs := uniqueWarmPairs(t.Context(), small, ambiguous); len(pairs) != 0 {
		t.Fatal("ambiguous pairing was warmed", pairs)
	}
	for _, size := range []int{1500, 5000} {
		large := warmDocument(size)
		started := time.Now()
		pairs := uniqueWarmPairs(t.Context(), large, large)
		if time.Since(started) > time.Second {
			t.Fatal("optional pairing exceeded bounded work")
		}
		if len(pairs) >= size {
			t.Fatal("large pairing ignored work budget")
		}
		if size == 5000 && len(pairs) != 0 {
			t.Fatal("partial reference collection cannot prove uniqueness")
		}
	}
}
