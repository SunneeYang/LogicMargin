package precompute

import (
	"fmt"
	"reflect"
	"testing"
)

func TestNativeJoinedRunsKeepOneSpineAndOutsideBranches(t *testing.T) {
	positions := []Point{{0, 0}, {-650, 210}, {0, 210}, {-600, 420}, {0, 420}, {-150, 630},
		{600, 420}, {900, 630}, {300, 840}, {850, 1050}, {300, 1050}, {-200, 1260},
		{300, 1260}, {300, 1470}, {900, 1680}, {300, 1680}}
	nodes := make([]PlanNode, len(positions))
	for i, position := range positions {
		kind := "action"
		switch i {
		case 1, 5, 7, 9, 11, 14:
			kind = "failure"
		case 15:
			kind = "result"
		}
		nodes[i] = PlanNode{ID: fmt.Sprintf("n%d", i), Kind: kind, Position: position}
	}
	pairs := [][2]int{{0, 1}, {0, 2}, {2, 3}, {2, 4}, {2, 6}, {3, 13}, {4, 5}, {4, 8},
		{6, 7}, {6, 8}, {8, 9}, {8, 10}, {10, 11}, {10, 12}, {12, 13}, {13, 14}, {13, 15}}
	edges := make([]PlanEdge, len(pairs))
	for i, pair := range pairs {
		edges[i] = PlanEdge{ID: fmt.Sprintf("%d-%d", pair[0], pair[1]), Source: fmt.Sprintf("n%d", pair[0]),
			Target: fmt.Sprintf("n%d", pair[1]), Label: "继续"}
	}
	originalNodes, originalEdges := append([]PlanNode{}, nodes...), append([]PlanEdge{}, edges...)
	for _, measured := range []bool{false, true} {
		t.Run(fmt.Sprintf("measured-%t", measured), func(t *testing.T) {
			input := LayoutInput{Nodes: nodes, Edges: edges}
			if measured {
				for i, node := range nodes {
					height := 128 + float64(i)*8
					if i == 3 {
						height = 148
					} else if i == 4 {
						height = 127
					}
					input.Sizes = append(input.Sizes, Size{ID: node.ID, Width: 248 + float64(i)*2, Height: height})
				}
			}
			result, handled, err := computeNativeLayout(t.Context(), input)
			if err != nil || !handled {
				t.Fatalf("native layout: handled=%t err=%v", handled, err)
			}
			x := func(i int) float64 { return result.Nodes[fmt.Sprintf("n%d", i)].Position.X }
			for _, i := range []int{2, 4, 8, 10, 12, 13, 15} {
				if x(i) != x(0) {
					t.Fatalf("joined main stage n%d moved off spine: %v != %v", i, x(i), x(0))
				}
			}
			columns := map[float64]bool{}
			for _, node := range result.Nodes {
				columns[node.Position.X] = true
			}
			if len(columns) != 3 || !(x(1) < x(0) && x(6) > x(0)) {
				t.Fatalf("branches must occupy two outside lanes, got %v", columns)
			}
			port := func(id, handle string) Port {
				for _, port := range result.Nodes[id].Ports {
					if port.ID == handle {
						return port
					}
				}
				t.Fatalf("missing port %s on %s", handle, id)
				return Port{}
			}
			bypass := result.Edges["3-13"]
			if port("n3", bypass.SourceHandle).Side != "left" || port("n13", bypass.TargetHandle).Side != "left" {
				t.Fatal("cross-stage side bypass must use outside ports")
			}
			if port("n8", "target:6-8").Offset >= port("n8", "source:8-9").Offset {
				t.Fatal("forward merge must enter above the later exit")
			}
			if result.Nodes["n4"].Position.Y+port("n4", "source:4-5").Offset <= result.Nodes["n3"].Position.Y+port("n3", "target:2-3").Offset {
				t.Fatal("a lower side exit must stay below a neighboring forward entrance on unequal-height cards")
			}
			if len(result.Nodes) != len(nodes) || len(result.Edges) != len(edges) {
				t.Fatal("layout dropped a node or edge")
			}
			for id, route := range result.Edges {
				for i := 1; i < len(route.Points); i++ {
					a, b := route.Points[i-1], route.Points[i]
					if a.X != b.X && a.Y != b.Y {
						t.Fatalf("%s: route is not orthogonal", id)
					}
					for _, node := range result.Nodes {
						if nativeCrosses(a, b, nativeBox{node.Position.X, node.Position.Y, node.Width, node.Height}, 0) {
							t.Fatalf("%s: route enters a card", id)
						}
					}
				}
			}
		})
	}
	if !reflect.DeepEqual(nodes, originalNodes) || !reflect.DeepEqual(edges, originalEdges) {
		t.Fatal("native layout modified its input")
	}
}

func TestNativeOtherBranchExitCannotFillSpine(t *testing.T) {
	for _, positions := range [][]Point{
		{{0, 0}, {0, 210}, {0, 420}, {600, 420}, {300, 630}},
		{{600, 0}, {600, 210}, {600, 420}, {900, 630}, {300, 840}},
	} {
		nodes := make([]PlanNode, len(positions))
		for i, position := range positions {
			kind := "action"
			if i == 4 {
				kind = "failure"
			}
			nodes[i] = PlanNode{ID: fmt.Sprintf("n%d", i), Kind: kind, Position: position}
		}
		edges := []PlanEdge{{ID: "a", Source: "n0", Target: "n1"}, {ID: "b", Source: "n1", Target: "n2"},
			{ID: "c", Source: "n1", Target: "n3"}, {ID: "d", Source: "n3", Target: "n4"}}
		result, handled, err := computeNativeLayout(t.Context(), LayoutInput{Nodes: nodes, Edges: edges})
		if err != nil || !handled {
			t.Fatalf("native layout: handled=%t err=%v", handled, err)
		}
		if result.Nodes["n4"].Position.X == result.Nodes["n0"].Position.X {
			t.Fatal("an exit from another branch occupied the spine")
		}
	}
}
