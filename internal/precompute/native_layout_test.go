package precompute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type nativeOracleCase struct {
	Name          string       `json:"name"`
	Input         LayoutInput  `json:"input"`
	Expected      LayoutResult `json:"expected"`
	ExpectedError string       `json:"expectedError"`
	Authored      bool         `json:"authored"`
}
type nativeOracle struct {
	Sources   string             `json:"sources"`
	Cases     []nativeOracleCase `json:"cases"`
	Collation []struct {
		A, B string
		Sign int
	} `json:"collation"`
	Identities []struct {
		Edge      PlanEdge
		JSON, URI string
	} `json:"identities"`
	Labels []struct {
		Text          string
		Width, Height float64
	} `json:"labels"`
}

func nativeReadOracle(t testing.TB, path string) nativeOracle {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var oracle nativeOracle
	if err := json.Unmarshal(data, &oracle); err != nil {
		t.Fatal(err)
	}
	if bundle, err := os.ReadFile("graph.bundle.js"); err == nil {
		if !strings.Contains(string(bundle), "// Sources SHA256: "+oracle.Sources+"\n") {
			t.Fatalf("stale oracle %s: sources %s differ from bundle", path, oracle.Sources)
		}
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return oracle
}

func nativeAssertEqual(t testing.TB, expected, actual LayoutResult) {
	t.Helper()
	// Metadata belongs to the root ComputeLayout entry, not this fast path.
	expected.SchemaVersion, expected.Algorithm, expected.Key = 0, "", ""
	actual.SchemaVersion, actual.Algorithm, actual.Key = 0, "", ""
	want, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if err := json.Unmarshal(want, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got, &b); err != nil {
		t.Fatal(err)
	}
	var compare func(string, any, any)
	compare = func(path string, want, got any) {
		t.Helper()
		switch value := want.(type) {
		case map[string]any:
			other, ok := got.(map[string]any)
			if !ok || len(value) != len(other) {
				t.Fatalf("%s: object shape differs: V8 %v; native %v", path, want, got)
			}
			for key, child := range value {
				actual, ok := other[key]
				if !ok {
					t.Fatalf("%s.%s missing", path, key)
				}
				compare(path+"."+key, child, actual)
			}
		case []any:
			other, ok := got.([]any)
			if !ok || len(value) != len(other) {
				t.Fatalf("%s: array shape differs: V8 %v; native %v", path, want, got)
			}
			for i, child := range value {
				compare(fmt.Sprintf("%s[%d]", path, i), child, other[i])
			}
		default:
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("%s: V8 %v; native %v", path, want, got)
			}
		}
	}
	compare("layout", a, b)
}

func TestNativeLayoutV8Oracle(t *testing.T) {
	for _, path := range []string{"testdata/layout-oracle.json", "testdata/native-layout-oracle.json"} {
		oracle := nativeReadOracle(t, path)
		t.Logf("%s source SHA %s", path, oracle.Sources)
		handledCount, fallbackCount, errorCount := 0, 0, 0
		for _, fixture := range oracle.Cases {
			t.Run(path+"/"+fixture.Name, func(t *testing.T) {
				before, _ := json.Marshal(fixture.Input)
				actual, handled, err := computeNativeLayout(t.Context(), fixture.Input)
				after, _ := json.Marshal(fixture.Input)
				if string(before) != string(after) {
					t.Fatal("input mutated")
				}
				if fixture.ExpectedError != "" {
					if !handled && !fixture.Authored {
						fallbackCount++
						return
					}
					if !handled || err == nil || err.Error() != strings.TrimPrefix(fixture.ExpectedError, "Error: ") {
						t.Fatalf("expected V8 error %q, handled=%t, native=%v", fixture.ExpectedError, handled, err)
					}
					errorCount++
					return
				}
				if !fixture.Expected.UsesAuthoredPositions && len(fixture.Input.Nodes) != 0 {
					if handled || err != nil {
						t.Fatalf("Dagre requires fallback: handled=%t, error=%v", handled, err)
					}
					fallbackCount++
					return
				}
				if !handled || err != nil {
					t.Fatalf("authored/empty case: handled=%t error=%v", handled, err)
				}
				handledCount++
				nativeAssertEqual(t, fixture.Expected, actual)
			})
		}
		t.Logf("native %d; fallback %d; matching errors %d", handledCount, fallbackCount, errorCount)
	}
}

func TestNativeLayoutJSStringSemantics(t *testing.T) {
	oracle := nativeReadOracle(t, "testdata/native-layout-oracle.json")
	for _, source := range []nativeOracle{nativeReadOracle(t, "testdata/layout-oracle.json"), oracle} {
		for _, pair := range source.Collation {
			if actual := nativeCompareIDs(pair.A, pair.B); actual != pair.Sign {
				t.Fatalf("UTF16 compare(%q,%q): JS %d native %d", pair.A, pair.B, pair.Sign, actual)
			}
		}
	}
	for _, item := range oracle.Identities {
		if actual := nativeEdgeIdentity(item.Edge); actual != item.JSON {
			t.Fatalf("JSON.stringify: JS %q native %q", item.JSON, actual)
		}
		if actual := nativeURIComponent(item.JSON); actual != item.URI {
			t.Fatalf("encodeURIComponent: JS %q native %q", item.URI, actual)
		}
	}
	for _, label := range oracle.Labels {
		if actual := nativeMeasureLabel(label.Text); actual.width != label.Width || actual.height != label.Height {
			t.Fatalf("label %q: JS %v,%v native %v", label.Text, label.Width, label.Height, actual)
		}
	}
	if nativeUTF16Length("a😀中🫠") != 6 {
		t.Fatal("label selection must use UTF16 code units")
	}
	if got := nativeEstimatedHeight(PlanNode{Title: strings.Repeat("😀", 28), Summary: strings.Repeat("🫠", 34)}); got != 184 {
		t.Fatalf("height uses source [...line].length (code points): %v", got)
	}
}

func nativeLargeInput() LayoutInput {
	input := LayoutInput{}
	for i := range 45 {
		input.Nodes = append(input.Nodes, PlanNode{ID: fmt.Sprintf("n%d", i), Kind: "action", Position: Point{X: float64(i%5) * 480, Y: float64(i/5) * 300}, Title: "step"})
		if i >= 5 {
			input.Edges = append(input.Edges, PlanEdge{ID: fmt.Sprintf("e%d", i-5), Source: fmt.Sprintf("n%d", i-5), Target: fmt.Sprintf("n%d", i), Label: fmt.Sprintf("condition %d", i-5)})
		}
	}
	return input
}

type nativeCancelContext struct {
	context.Context
	calls  atomic.Int64
	cancel context.CancelFunc
	limit  int64
}

func (c *nativeCancelContext) Err() error {
	if c.calls.Add(1) == c.limit {
		c.cancel()
	}
	return c.Context.Err()
}

func TestNativeLayoutCancellationAndWorkers(t *testing.T) {
	input := nativeLargeInput()
	expected, handled, err := computeNativeLayout(t.Context(), input)
	if err != nil || !handled {
		t.Fatalf("initial layout: %t %v", handled, err)
	}
	for _, limit := range []int64{1, 30, 150, 1000} {
		ctx, cancel := context.WithCancel(t.Context())
		counting := &nativeCancelContext{Context: ctx, cancel: cancel, limit: limit}
		start := time.Now()
		_, handled, err := computeNativeLayout(counting, input)
		cancel()
		if !handled || !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel after %d checks: %t %v", limit, handled, err)
		}
		if time.Since(start) > time.Second {
			t.Fatal("cancellation did not interrupt promptly")
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Microsecond)
	_, handled, err = computeNativeLayout(ctx, input)
	cancel()
	if !handled || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %t %v", handled, err)
	}
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			for range 3 {
				actual, handled, err := computeNativeLayout(t.Context(), input)
				if err != nil || !handled {
					t.Errorf("worker: %t %v", handled, err)
					return
				}
				nativeAssertEqual(t, expected, actual)
			}
		})
	}
	workers.Wait()
}

func TestNativeLayoutFallback(t *testing.T) {
	for _, nodes := range [][]PlanNode{
		{{ID: "single", Kind: "action"}},
		{{ID: "a", Kind: "action"}, {ID: "b", Kind: "action"}},
		{{ID: "a", Kind: "action", Position: Point{X: math.NaN()}}, {ID: "b", Kind: "action", Position: Point{Y: 300}}},
		{{ID: "a", Kind: "action", Position: Point{X: math.Inf(1)}}, {ID: "b", Kind: "action", Position: Point{Y: 300}}},
	} {
		if _, handled, err := computeNativeLayout(t.Context(), LayoutInput{Nodes: nodes}); handled || err != nil {
			t.Fatalf("expected VM fallback, handled=%t error=%v", handled, err)
		}
	}
}

func BenchmarkNativeLayout45(b *testing.B) {
	input := nativeLargeInput()
	b.ReportAllocs()
	for b.Loop() {
		if _, handled, err := computeNativeLayout(b.Context(), input); err != nil || !handled {
			b.Fatalf("%t %v", handled, err)
		}
	}
}
