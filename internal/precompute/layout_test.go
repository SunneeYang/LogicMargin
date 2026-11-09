package precompute

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dop251/goja"
)

type layoutOracleCase struct {
	Name          string       `json:"name"`
	Input         LayoutInput  `json:"input"`
	Expected      LayoutResult `json:"expected"`
	ExpectedError string       `json:"expectedError"`
}

type layoutOracle struct {
	Sources   string `json:"sources"`
	Node      string `json:"node"`
	ICU       string `json:"icu"`
	Locale    string `json:"locale"`
	Collation []struct {
		A    string `json:"a"`
		B    string `json:"b"`
		Sign int64  `json:"sign"`
	} `json:"collation"`
	Cases []layoutOracleCase `json:"cases"`
}

func readLayoutOracle(t testing.TB) layoutOracle {
	t.Helper()
	data, err := os.ReadFile("testdata/layout-oracle.json")
	if err != nil {
		t.Fatal(err)
	}
	var oracle layoutOracle
	if err := json.Unmarshal(data, &oracle); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(layoutBundle, "// Sources SHA256: "+oracle.Sources+"\n") {
		t.Fatal("V8 oracle is stale; run node scripts/build-graph-precompute.mjs --write-oracle")
	}
	return oracle
}

// Compare every field and every array element, including handle IDs and route/port order.
func compareLayoutJSON(t testing.TB, path string, want, got any) {
	t.Helper()
	switch want := want.(type) {
	case float64:
		value, ok := got.(float64)
		if !ok || math.Abs(want-value) > 1e-8 {
			t.Fatalf("%s: V8 %v, Goja %v", path, want, got)
		}
	case map[string]any:
		value, ok := got.(map[string]any)
		if !ok || len(want) != len(value) {
			t.Fatalf("%s: object shape differs: V8 %v, Goja %v", path, want, got)
		}
		for key, child := range want {
			actual, ok := value[key]
			if !ok {
				t.Fatalf("%s.%s: missing key", path, key)
			}
			compareLayoutJSON(t, path+"."+key, child, actual)
		}
	case []any:
		value, ok := got.([]any)
		if !ok || len(want) != len(value) {
			t.Fatalf("%s: array shape differs: V8 %v, Goja %v", path, want, got)
		}
		for index, child := range want {
			compareLayoutJSON(t, fmt.Sprintf("%s[%d]", path, index), child, value[index])
		}
	default:
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("%s: V8 %v, Goja %v", path, want, got)
		}
	}
}

func assertLayoutEqual(t testing.TB, want, got LayoutResult) {
	t.Helper()
	want.SchemaVersion, want.Algorithm = SchemaVersion, LayoutAlgorithm()
	var expected, actual any
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantJSON, &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(gotJSON, &actual); err != nil {
		t.Fatal(err)
	}
	compareLayoutJSON(t, "layout", expected, actual)
}

func TestLayoutV8Oracle(t *testing.T) {
	oracle := readLayoutOracle(t)
	t.Logf("V8 oracle: Node %s, ICU %s, locale %s", oracle.Node, oracle.ICU, oracle.Locale)
	for _, fixture := range oracle.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			before, _ := json.Marshal(fixture.Input)
			actual, err := ComputeLayout(t.Context(), fixture.Input)
			if fixture.ExpectedError != "" {
				if err == nil {
					t.Fatalf("V8 rejected this graph (%s), Goja must not silently fall back", fixture.ExpectedError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertLayoutEqual(t, fixture.Expected, actual)
			for id, route := range actual.Edges {
				for i := 1; i < len(route.Points); i++ {
					a, b := route.Points[i-1], route.Points[i]
					if math.Abs(a.X-b.X) > 1e-7 && math.Abs(a.Y-b.Y) > 1e-7 {
						t.Fatalf("%s: diagonal route segment", id)
					}
				}
			}
			after, _ := json.Marshal(fixture.Input)
			if string(before) != string(after) {
				t.Fatal("input mutated")
			}
		})
	}
}

func TestLayoutStableIDOrderAcrossRuntimes(t *testing.T) {
	oracle := readLayoutOracle(t)
	vm := goja.New()
	program, err := layoutProgram()
	if err != nil {
		t.Fatal(err)
	}
	_, err = vm.RunProgram(program)
	if err != nil {
		t.Fatal(err)
	}
	compare, _ := goja.AssertFunction(vm.Get("LogicMarginLayout").ToObject(vm).Get("compareGraphIds"))
	mismatches := 0
	for _, pair := range oracle.Collation {
		actual, err := compare(goja.Undefined(), vm.ToValue(pair.A), vm.ToValue(pair.B))
		if err != nil {
			t.Fatal(err)
		}
		if actual.ToInteger() != pair.Sign {
			mismatches++
			if mismatches <= 6 {
				t.Errorf("compareGraphIds(%q, %q): V8 %d, Goja %d", pair.A, pair.B, pair.Sign, actual.ToInteger())
			}
		}
	}
	if mismatches != 0 {
		t.Fatalf("BLOCKING: %d/%d collation pairs differ from V8; canonical union/route order can change", mismatches, len(oracle.Collation))
	}
}

func TestLayoutRuntimeCompatibility(t *testing.T) {
	if LayoutAlgorithm() != fmt.Sprintf("graph-hybrid-v1-%x", sha256.Sum256([]byte(layoutBundle))) {
		t.Fatal("algorithm does not bind the embedded bundle")
	}
	native, err := os.ReadFile("native_layout.go")
	if err != nil || !strings.Contains(layoutBundle, fmt.Sprintf("// Native SHA256: %x\n", sha256.Sum256(native))) {
		t.Fatal("embedded native algorithm fingerprint is stale; rebuild graph.bundle.js", err)
	}
	program, err := layoutProgram()
	if err != nil {
		t.Fatal(err)
	}
	vm := goja.New()
	if _, err := vm.RunProgram(program); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`(() => {
		const original = [, undefined, ['nested'], {a: undefined, b: 1}];
		const copy = structuredClone(original);
		copy[2][0] = 'changed';
		return !(0 in copy) && 1 in copy && copy[1] === undefined && Object.hasOwn(copy[3], 'a')
			&& original[2][0] === 'nested' && copy[3].b === 1
			&& [1, 2].at(-1) === 2 && [[1], [2]].flat().length === 2
			&& [1, 2].flatMap(x => [x, x]).length === 4;
	})()`)
	if err != nil || !value.ToBoolean() {
		t.Fatalf("layout runtime primitives: %v, %v", value, err)
	}
}

func layoutTestInput() LayoutInput {
	return LayoutInput{
		Nodes: []PlanNode{{ID: "a", Kind: "action", Position: Point{X: 0, Y: 0}, Title: "a"}, {ID: "b", Kind: "result", Position: Point{X: 0, Y: 300}, Title: "b"}},
		Edges: []PlanEdge{{ID: "e", Source: "a", Target: "b", Label: "continue"}},
	}
}

func TestLayoutValidation(t *testing.T) {
	for name, change := range map[string]func(*LayoutInput){
		"empty ID":              func(input *LayoutInput) { input.Nodes[0].ID = "" },
		"invalid utf8 ID":       func(input *LayoutInput) { input.Nodes[0].ID = string([]byte{0xff}) },
		"graphlib null ID":      func(input *LayoutInput) { input.Nodes[0].ID = "a\x00b" },
		"graphlib delimiter ID": func(input *LayoutInput) { input.Edges[0].ID = "a\x01b" },
		"duplicate nodes":       func(input *LayoutInput) { input.Nodes = append(input.Nodes, input.Nodes[0]) },
		"duplicate edges":       func(input *LayoutInput) { input.Edges = append(input.Edges, input.Edges[0]) },
		"invalid kind":          func(input *LayoutInput) { input.Nodes[0].Kind = "unknown" },
		"NaN coordinate":        func(input *LayoutInput) { input.Nodes[0].Position.X = math.NaN() },
		"Inf coordinate":        func(input *LayoutInput) { input.Nodes[0].Position.Y = math.Inf(1) },
		"large coordinate":      func(input *LayoutInput) { input.Nodes[0].Position.Y = 1e20 },
		"missing endpoint":      func(input *LayoutInput) { input.Edges[0].Target = "missing" },
		"reference endpoint": func(input *LayoutInput) {
			input.Reference = &Graph{Nodes: input.Nodes, Edges: []PlanEdge{{ID: "bad", Source: "a", Target: "missing"}}}
		},
		"cross-side endpoint": func(input *LayoutInput) { input.Reference = &Graph{Nodes: input.Nodes[:1], Edges: input.Edges} },
		"unknown size":        func(input *LayoutInput) { input.Sizes = []Size{{ID: "missing", Width: 1, Height: 1}} },
		"zero size":           func(input *LayoutInput) { input.Sizes = []Size{{ID: "a", Width: 0, Height: 1}} },
		"negative size":       func(input *LayoutInput) { input.Sizes = []Size{{ID: "a", Width: -1, Height: 1}} },
		"Inf size":            func(input *LayoutInput) { input.Sizes = []Size{{ID: "a", Width: math.Inf(1), Height: 1}} },
		"duplicate sizes": func(input *LayoutInput) {
			input.Sizes = []Size{{ID: "a", Width: 1, Height: 1}, {ID: "a", Width: 1, Height: 1}}
		},
		"text budget": func(input *LayoutInput) { input.Nodes[0].Summary = strings.Repeat("x", 1_000_001) },
		"combined node budget": func(input *LayoutInput) {
			input.Nodes = make([]PlanNode, 257)
			input.Reference = &Graph{Nodes: make([]PlanNode, 256)}
		},
		"combined edge budget": func(input *LayoutInput) {
			input.Edges = make([]PlanEdge, 513)
			input.Reference = &Graph{Edges: make([]PlanEdge, 512)}
		},
		"work budget": func(input *LayoutInput) { input.Nodes = make([]PlanNode, 200); input.Edges = make([]PlanEdge, 200) },
	} {
		t.Run(name, func(t *testing.T) {
			input := layoutTestInput()
			change(&input)
			if _, err := ComputeLayout(t.Context(), input); err == nil {
				t.Fatal("invalid or over-budget input accepted")
			}
		})
	}
}

func TestLayoutHistoryAndWorkers(t *testing.T) {
	oracle := readLayoutOracle(t)
	var fixtures []layoutOracleCase
	for _, fixture := range oracle.Cases {
		if fixture.Name == "comparison-authored-B-R" || fixture.Name == "comparison-dagre-R-B" {
			fixtures = append(fixtures, fixture)
		}
	}
	if len(fixtures) != 2 {
		t.Fatal("missing history fixtures")
	}
	for _, index := range []int{0, 1, 0} {
		actual, err := ComputeLayout(t.Context(), fixtures[index].Input)
		if err != nil {
			t.Fatal(err)
		}
		assertLayoutEqual(t, fixtures[index].Expected, actual)
	}
	var workers sync.WaitGroup
	for index := range 8 {
		workers.Go(func() {
			fixture := fixtures[index%2]
			actual, err := ComputeLayout(t.Context(), fixture.Input)
			if err != nil {
				t.Error(err)
				return
			}
			assertLayoutEqual(t, fixture.Expected, actual)
		})
	}
	workers.Wait()
}

func largeLayoutInput(count int, authored bool) LayoutInput {
	input := LayoutInput{}
	for index := range count {
		position := Point{}
		if authored {
			position = Point{X: float64(index%5) * 480, Y: float64(index/5) * 300}
		}
		input.Nodes = append(input.Nodes, PlanNode{ID: fmt.Sprintf("n%d", index), Kind: "action", Position: position, Title: "step"})
		if index >= 5 {
			input.Edges = append(input.Edges, PlanEdge{ID: fmt.Sprintf("e%d", index-5), Source: fmt.Sprintf("n%d", index-5), Target: fmt.Sprintf("n%d", index), Label: fmt.Sprintf("condition %d", index-5)})
		}
	}
	return input
}

func TestLayoutCancellationAndRecovery(t *testing.T) {
	expected, err := ComputeLayout(t.Context(), layoutTestInput())
	if err != nil {
		t.Fatal(err)
	}
	for _, timeout := range []time.Duration{0, 10 * time.Millisecond} {
		ctx, cancel := context.WithTimeout(t.Context(), timeout)
		start := time.Now()
		_, err := ComputeLayout(ctx, largeLayoutInput(45, false))
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected deadline, got %v", err)
		}
		if time.Since(start) > 2*time.Second {
			t.Fatal("VM cancellation did not interrupt promptly")
		}
		actual, err := ComputeLayout(t.Context(), layoutTestInput())
		if err != nil {
			t.Fatalf("fresh VM after cancellation failed: %v", err)
		}
		assertLayoutEqual(t, expected, actual)
	}
}

func BenchmarkLayoutCold(b *testing.B) {
	for _, authored := range []bool{true, false} {
		b.Run(fmt.Sprintf("45-nodes-authored-%t", authored), func(b *testing.B) {
			input := largeLayoutInput(45, authored)
			b.ReportAllocs()
			for b.Loop() {
				if _, err := ComputeLayout(b.Context(), input); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkLayoutVMAuthored45(b *testing.B) {
	input := nativeLargeInput()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := computeLayoutInVM(b.Context(), input); err != nil {
			b.Fatal(err)
		}
	}
}
