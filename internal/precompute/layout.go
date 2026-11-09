package precompute

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/dop251/goja"
)

//go:embed graph.bundle.js
var layoutBundle string

var layoutProgram = sync.OnceValues(func() (*goja.Program, error) {
	return goja.Compile("graph.bundle.js", layoutBundle, true)
})

var layoutAlgorithm = fmt.Sprintf("graph-hybrid-v1-%x", sha256.Sum256([]byte(layoutBundle)))

func LayoutAlgorithm() string { return layoutAlgorithm }

// ComputeLayout uses native orthogonal routing when authored positions work, otherwise a fresh Dagre VM.
func ComputeLayout(ctx context.Context, input LayoutInput) (LayoutResult, error) {
	if err := ctx.Err(); err != nil {
		return LayoutResult{}, err
	}
	if err := validateLayoutInput(input); err != nil {
		return LayoutResult{}, err
	}
	result, handled, err := computeNativeLayout(ctx, input)
	if !handled {
		result, err = computeLayoutInVM(ctx, input)
	}
	if err != nil {
		return LayoutResult{}, err
	}
	if err := validateLayoutResult(input, result); err != nil {
		return LayoutResult{}, err
	}
	result.SchemaVersion = SchemaVersion
	result.Algorithm = LayoutAlgorithm()
	return result, nil
}

func computeLayoutInVM(ctx context.Context, input LayoutInput) (LayoutResult, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return LayoutResult{}, fmt.Errorf("encode layout input: %w", err)
	}
	program, err := layoutProgram()
	if err != nil {
		return LayoutResult{}, fmt.Errorf("compile layout bundle: %w", err)
	}
	vm := goja.New()
	interrupted := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		vm.Interrupt(ctx.Err())
		close(interrupted)
	})
	defer func() {
		if !stop() {
			<-interrupted
		}
	}()
	if _, err = vm.RunProgram(program); err != nil {
		return LayoutResult{}, layoutVMError(ctx, err)
	}
	compute, ok := goja.AssertFunction(vm.Get("LogicMarginLayout").ToObject(vm).Get("computeJSON"))
	if !ok {
		return LayoutResult{}, errors.New("layout bundle has no computeJSON function")
	}
	// Pass JSON as a string value, never executable JavaScript or Go-backed collections.
	value, err := compute(goja.Undefined(), vm.ToValue(string(encoded)))
	if err != nil {
		return LayoutResult{}, layoutVMError(ctx, err)
	}
	if err := ctx.Err(); err != nil {
		return LayoutResult{}, err
	}
	var result LayoutResult
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		return LayoutResult{}, fmt.Errorf("decode layout result: %w", err)
	}
	return result, nil
}

func layoutVMError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("compute layout: %w", err)
}

func finiteLayout(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func validLayoutID(id string) bool {
	// Graphlib reserves NUL and SOH for its internal node/edge identities.
	return id != "" && len(id) <= 1024 && utf8.ValidString(id) && !strings.ContainsAny(id, "\x00\x01")
}

func validateLayoutInput(input LayoutInput) error {
	graphs := []Graph{{Nodes: input.Nodes, Edges: input.Edges}}
	if input.Reference != nil {
		graphs = append(graphs, *input.Reference)
	}
	nodes, edges, text := 0, 0, 0
	allIDs := make(map[string]bool)
	for _, graph := range graphs {
		nodes += len(graph.Nodes)
		edges += len(graph.Edges)
	}
	// Both comparison sides count, even when IDs overlap; routing candidate costs grow superlinearly.
	if nodes > 512 || edges > 1024 || int64(nodes)*int64(edges)*int64(nodes+edges) > 8_000_000 || len(input.Sizes) > 512 {
		return errors.New("layout input exceeds computation budget")
	}
	for _, graph := range graphs {
		ids, edgeIDs := make(map[string]bool), make(map[string]bool)
		for _, node := range graph.Nodes {
			if !validLayoutID(node.ID) || ids[node.ID] {
				return fmt.Errorf("invalid or duplicate layout node ID %q", node.ID)
			}
			ids[node.ID], allIDs[node.ID] = true, true
			switch node.Kind {
			case "action", "decision", "result", "failure":
			default:
				return fmt.Errorf("invalid layout node kind %q", node.Kind)
			}
			if !finiteLayout(node.Position.X) || !finiteLayout(node.Position.Y) || math.Abs(node.Position.X) > 1e7 || math.Abs(node.Position.Y) > 1e7 {
				return fmt.Errorf("invalid position for layout node %q", node.ID)
			}
			if !utf8.ValidString(node.Title) || !utf8.ValidString(node.Summary) {
				return fmt.Errorf("invalid text for layout node %q", node.ID)
			}
			text += len(node.ID) + len(node.Title) + len(node.Summary)
		}
		for _, edge := range graph.Edges {
			if !validLayoutID(edge.ID) || edgeIDs[edge.ID] || !ids[edge.Source] || !ids[edge.Target] || !utf8.ValidString(edge.Label) {
				return fmt.Errorf("invalid layout edge %q or endpoint", edge.ID)
			}
			edgeIDs[edge.ID] = true
			text += len(edge.ID) + len(edge.Label)
		}
	}
	if text > 1_000_000 {
		return errors.New("layout text exceeds computation budget")
	}
	sized := make(map[string]bool)
	for _, size := range input.Sizes {
		if !allIDs[size.ID] || sized[size.ID] || !finiteLayout(size.Width) || !finiteLayout(size.Height) || size.Width <= 0 || size.Height <= 0 || size.Width > 1e5 || size.Height > 1e5 {
			return fmt.Errorf("invalid or duplicate layout size %q", size.ID)
		}
		sized[size.ID] = true
	}
	return nil
}

func validateLayoutResult(input LayoutInput, result LayoutResult) error {
	if len(result.Nodes) != len(input.Nodes) || len(result.Edges) != len(input.Edges) {
		return errors.New("layout returned an incomplete graph")
	}
	for _, node := range input.Nodes {
		placed, ok := result.Nodes[node.ID]
		if !ok || !finiteLayout(placed.Position.X) || !finiteLayout(placed.Position.Y) || !finiteLayout(placed.Width) || !finiteLayout(placed.Height) || placed.Width <= 0 || placed.Height <= 0 {
			return fmt.Errorf("layout returned invalid geometry for node %q", node.ID)
		}
		for _, port := range placed.Ports {
			if !finiteLayout(port.Offset) {
				return fmt.Errorf("layout returned invalid port for node %q", node.ID)
			}
		}
	}
	for _, edge := range input.Edges {
		route, ok := result.Edges[edge.ID]
		if !ok || len(route.Points) < 2 || route.SourceHandle == "" || route.TargetHandle == "" || !finiteLayout(route.Label.X) || !finiteLayout(route.Label.Y) || route.LabelWidth != nil && !finiteLayout(*route.LabelWidth) || route.LabelHeight != nil && !finiteLayout(*route.LabelHeight) {
			return fmt.Errorf("layout returned invalid route for edge %q", edge.ID)
		}
		for i, point := range route.Points {
			if !finiteLayout(point.X) || !finiteLayout(point.Y) {
				return fmt.Errorf("layout returned invalid route point for edge %q", edge.ID)
			}
			if i > 0 && math.Abs(point.X-route.Points[i-1].X) > 1e-7 && math.Abs(point.Y-route.Points[i-1].Y) > 1e-7 {
				return fmt.Errorf("layout returned a diagonal route for edge %q", edge.ID)
			}
		}
	}
	return nil
}
