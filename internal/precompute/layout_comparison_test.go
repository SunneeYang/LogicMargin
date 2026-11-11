package precompute

import (
	"fmt"
	"strings"
	"testing"
)

func TestDisjointComparisonPreservesVisiblePlacement(t *testing.T) {
	flow := []PlanNode{
		{ID: "start", Kind: "action", Position: Point{0, 0}},
		{ID: "check", Kind: "decision", Position: Point{0, 210}},
		{ID: "work", Kind: "action", Position: Point{0, 420}},
		{ID: "done", Kind: "result", Position: Point{0, 630}},
		{ID: "rejected", Kind: "failure", Position: Point{480, 420}},
	}
	edges := []PlanEdge{{ID: "start-check", Source: "start", Target: "check"},
		{ID: "check-work", Source: "check", Target: "work"}, {ID: "work-done", Source: "work", Target: "done"},
		{ID: "rejected", Source: "check", Target: "rejected"}, {ID: "retry", Source: "work", Target: "check"}}
	placeholder := Graph{Nodes: []PlanNode{{ID: "previous-placeholder", Kind: "action", Position: Point{0, 0}}}, Edges: []PlanEdge{}}
	for _, collapsed := range []bool{false, true} {
		current := Graph{Nodes: append([]PlanNode{}, flow...), Edges: edges}
		if collapsed {
			for i := range current.Nodes {
				current.Nodes[i].Position = Point{}
			}
		}
		for _, measured := range []bool{false, true} {
			for _, sides := range [][2]Graph{{current, placeholder}, {placeholder, current}} {
				visible, reference := sides[0], sides[1]
				input := LayoutInput{Nodes: visible.Nodes, Edges: visible.Edges, Sizes: []Size{}}
				if measured {
					for i, node := range visible.Nodes {
						input.Sizes = append(input.Sizes, Size{ID: node.ID, Width: 248 + float64(i)*4, Height: 128 + float64(i)*12})
					}
				}
				standalone, err := ComputeLayout(t.Context(), input)
				if err != nil {
					t.Fatal(err)
				}
				input.Reference = &reference
				compared, err := ComputeLayout(t.Context(), input)
				if err != nil {
					t.Fatal(err)
				}
				if compared.UsesAuthoredPositions != standalone.UsesAuthoredPositions {
					t.Fatalf("independent baseline changed layout mode: collapsed=%t measured=%t", collapsed, measured)
				}
				for id, want := range standalone.Nodes {
					got := compared.Nodes[id]
					if got.Position != want.Position || got.Width != want.Width || got.Height != want.Height {
						t.Fatalf("independent baseline moved %s: %v -> %v", id, want, got)
					}
				}
				for _, edge := range visible.Edges {
					route := compared.Edges[edge.ID]
					if !strings.HasPrefix(route.SourceHandle, "source:comparison:") || !strings.HasPrefix(route.TargetHandle, "target:comparison:") {
						t.Fatal("comparison handle identity changed", route)
					}
				}
			}
		}
	}
}

func TestNativeBranchLaneReuse(t *testing.T) {
	positions := []Point{{0, 0}, {0, 210}, {-450, 420}, {0, 420}, {450, 630}, {0, 630},
		{0, 840}, {-400, 1050}, {400, 1050}, {0, 1260}}
	nodes := make([]PlanNode, len(positions))
	for i, position := range positions {
		nodes[i] = PlanNode{ID: fmt.Sprint(i), Kind: "action", Position: position}
	}
	pairs := [][2]int{{0, 1}, {1, 2}, {1, 3}, {3, 4}, {3, 5}, {5, 6}, {6, 7}, {6, 8}, {7, 6}, {7, 9}, {8, 9}}
	edges := make([]PlanEdge, len(pairs))
	for i, pair := range pairs {
		edges[i] = PlanEdge{ID: fmt.Sprint(i), Source: fmt.Sprint(pair[0]), Target: fmt.Sprint(pair[1])}
	}
	for _, measured := range []bool{false, true} {
		var sizes []Size
		if measured {
			for i, node := range nodes {
				sizes = append(sizes, Size{ID: node.ID, Width: 248 + float64(i)*8, Height: 160 + float64(i)*12})
			}
		}
		placed, handled, err := computeNativeLayout(t.Context(), LayoutInput{Nodes: nodes, Edges: edges, Sizes: sizes})
		if err != nil || !handled {
			t.Fatalf("native branch layout: handled=%t err=%v", handled, err)
		}
		x := func(i int) float64 { return placed.Nodes[fmt.Sprint(i)].Position.X }
		if x(2) != x(7) || x(4) != x(8) || !(x(2) < x(0) && x(0) < x(4)) {
			t.Fatalf("branches did not reuse their side lanes: %v", placed.Nodes)
		}
		for _, i := range []int{1, 3, 5, 6, 9} {
			if x(i) != x(0) {
				t.Fatal("main spine moved")
			}
		}
	}
}
