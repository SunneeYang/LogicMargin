package precompute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

func contextWindow(t *testing.T, code, saved string) *StructureContext {
	t.Helper()
	from := strings.Index(code, saved)
	if from < 0 {
		t.Fatal("missing saved text")
	}
	units := func(s string) int { return len(utf16.Encode([]rune(s))) }
	return &StructureContext{Code: code, From: units(code[:from]), To: units(code[:from+len(saved)])}
}
func assertProjected(t *testing.T, result StructureResult, before, after string) {
	t.Helper()
	base, a, b, err := structureBase(before, after, result.Language)
	if err != nil || result.Before != base.Before || result.After != base.After {
		t.Fatal("result describes full source instead of saved text", result.Before, result.After, err)
	}
	for i, text := range []diffText{a, b} {
		ranges := result.Highlights.Before
		if i == 1 {
			ranges = result.Highlights.After
		}
		for _, r := range ranges {
			if _, ok := sourceRange(text, r); !ok || r.To <= r.From {
				t.Fatal("invalid projected highlight", r, text.source)
			}
		}
	}
}
func TestStructureContextRepairsTruncationWithoutChangingSavedSource(t *testing.T) {
	before := "if (enabled) {\n return value < 10;"
	after := strings.Replace(before, "<", "<=", 1)
	a := contextWindow(t, "export function check(value: number) {\n"+before+"\n}\nreturn false;\n}\n", before)
	b := contextWindow(t, strings.Replace(a.Code, before, after, 1), after)
	plain, err := ComputeStructure(t.Context(), before, after, "ts")
	if err != nil || plain.Mode != "text" || plain.Reason != "invalid-syntax" {
		t.Fatal(plain, err)
	}
	result, err := ComputeStructureWithContext(t.Context(), before, after, "ts", a, b)
	if err != nil || result.Mode != "structural" || len(result.Highlights.After) != 1 || len(result.Scopes)+len(result.Moves) != 0 {
		t.Fatal(result, err)
	}
	assertProjected(t, result, before, after)
	if result.Highlights.After[0] != (CodeRange{From: strings.Index(after, "="), To: strings.Index(after, "=") + 1}) {
		t.Fatal(result.Highlights)
	}
	for _, contexts := range [][2]*StructureContext{{a, nil}, {nil, b}} {
		result, err := ComputeStructureWithContext(t.Context(), before, after, "ts", contexts[0], contexts[1])
		if err != nil || result.Mode != "text" || result.Reason != "invalid-syntax" {
			t.Fatal("missing context must use saved snippet path", result, err)
		}
	}
}
func TestStructureContextOutsideChangesAndFormatting(t *testing.T) {
	saved := "if (enabled) {\n return value < 10;"
	code := "function check(value) {\n" + saved + "\n}\n}\nfunction other(){return 1;}\n"
	a := contextWindow(t, code, saved)
	b := contextWindow(t, strings.Replace(code, "return 1", "return 2", 1), saved)
	result, err := ComputeStructureWithContext(t.Context(), saved, saved, "js", a, b)
	if err != nil || result.Mode != "structural" || len(result.Highlights.Before)+len(result.Highlights.After)+len(result.Moves) != 0 || result.FormattingOnly {
		t.Fatal("outside change polluted snippet", result, err)
	}
	after := strings.Replace(saved, "value < 10", "value<10", 1)
	b = contextWindow(t, strings.Replace(code, saved, after, 1), after)
	result, err = ComputeStructureWithContext(t.Context(), saved, after, "js", a, b)
	if err != nil || result.Mode != "structural" || !result.FormattingOnly || len(result.Highlights.Before)+len(result.Highlights.After) != 0 {
		t.Fatal(result, err)
	}
}
func TestStructureContextMoveProjection(t *testing.T) {
	one, two, three := "func one(){return 1}\n", "func two(){return 2}\n", "func three(){return 3}\n"
	before, after := "package p\n"+one+two+three, "package p\n"+three+one+two
	for _, sample := range []struct {
		name, old, current string
		moves              int
	}{
		{"both-cut", "return 3", "return 3", 0},
		{"leaves-window", three, one, 0},
		{"enters-window", one, three, 0},
		{"one-cut", three, "return 3", 0},
		{"complete", three, three, 1},
	} {
		t.Run(sample.name, func(t *testing.T) {
			result, err := ComputeStructureWithContext(t.Context(), sample.old, sample.current, "go", contextWindow(t, before, sample.old), contextWindow(t, after, sample.current))
			if err != nil || result.Mode != "structural" || len(result.Moves) != sample.moves {
				t.Fatal(result, err)
			}
			assertProjected(t, result, sample.old, sample.current)
			if sample.moves == 0 && len(result.Highlights.Before)+len(result.Highlights.After) == 0 {
				t.Fatal("clipped movement lost its emphasis", result)
			}
			if sample.moves == 1 {
				move := result.Moves[0]
				if move.Before.From != 0 || move.After.From != 0 || move.Comparison.Before.Length != len(strings.TrimSpace(three)) || len(move.Comparison.Changes) != 0 {
					t.Fatal("move comparison no longer uses scope-local saved coordinates", move)
				}
			}
		})
	}
}
func TestStructureContextUTF16AndNormalizedCRLF(t *testing.T) {
	before := "if (ok) {\nreturn \"😀\";"
	after := strings.Replace(before, "😀", "😁", 1)
	raw := "// prefix 😀\r\nfunction f(){\r\n" + strings.ReplaceAll(before, "\n", "\r\n") + "\r\n}\r\n}\r\n"
	code := strings.ReplaceAll(raw, "\r\n", "\n") // The source-cache caller owns normalization.
	a, b := contextWindow(t, code, before), contextWindow(t, strings.Replace(code, before, after, 1), after)
	result, err := ComputeStructureWithContext(t.Context(), before, after, "js", a, b)
	if err != nil || result.Mode != "structural" || len(result.Highlights.After) != 1 {
		t.Fatal(result, err)
	}
	assertProjected(t, result, before, after)
	if r := result.Highlights.After[0]; r.To-r.From != 2 {
		t.Fatal("highlight split emoji", r)
	}
	for _, bad := range []StructureContext{
		{Code: raw, From: a.From, To: a.To},
		{Code: code, From: a.From + 1, To: a.To},
		{Code: "😀", From: 1, To: 2},
		{Code: code, From: 0, To: 999999},
		{Code: code, From: -1, To: 0},
	} {
		if _, err := ComputeStructureWithContext(t.Context(), before, after, "js", &bad, b); err == nil {
			t.Fatal("invalid context accepted", bad)
		}
	}
}
func TestStructureContextSyntaxDamageAndSensitiveStatements(t *testing.T) {
	broken := contextWindow(t, "function f(){if(ok){return 1;", "if(ok){return 1;")
	result, err := ComputeStructureWithContext(t.Context(), "if(ok){return 1;", "if(ok){return 1;", "js", broken, broken)
	if err != nil || result.Mode != "text" || result.Reason != "invalid-syntax" {
		t.Fatal(result, err)
	}
	for _, sample := range []struct{ name, lang, old, current string }{
		{"go-statement", "go", "func f(){work()}\nfunc stable(){return 7}", "func f(){work(); added()}\nfunc stable(){return 7}"},
		{"go-return", "go", "func f(){return x()}\nfunc stable(){return 7}", "func f(){return\nx()}\nfunc stable(){return 7}"},
		{"js-asi", "js", "function f(){return x()}\nfunction stable(){return 7}", "function f(){return\nx()}\nfunction stable(){return 7}"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			result, err := ComputeStructureWithContext(t.Context(), sample.old, sample.current, sample.lang, contextWindow(t, sample.old, sample.old), contextWindow(t, sample.current, sample.current))
			if err != nil || result.Mode != "structural" || result.FormattingOnly || len(result.Highlights.After) == 0 {
				t.Fatal("sensitive syntax hidden as formatting", result, err)
			}
			for _, r := range result.Highlights.After {
				if r.To > strings.Index(sample.current, "\nfunc") {
					t.Fatal("uncertain syntax discarded reliable sibling structure", result.Highlights)
				}
			}
		})
	}
}

func TestStructureContextSharedFullFileAndPersistentCache(t *testing.T) {
	directory := t.TempDir()
	engine := NewEngine(directory)
	defer engine.Close()
	before := "package p\nfunc one(){return 1}\nfunc two(){return 2}\n"
	after := strings.ReplaceAll(strings.ReplaceAll(before, "return 1", "return 3"), "return 2", "return 4")
	compute := func(engine *Engine, old, current string) (StructureResult, string) {
		t.Helper()
		raw, status, err := engine.StructureWithContext(t.Context(), old, current, "go", contextWindow(t, before, old), contextWindow(t, after, current))
		var result StructureResult
		if err != nil || json.Unmarshal(raw, &result) != nil || result.Mode != "structural" {
			t.Fatal(result, err)
		}
		assertProjected(t, result, old, current)
		return result, status
	}
	first, status := compute(engine, "return 1", "return 3")
	if status != "miss" || engine.Stats().Computations != 4 { // two documents, one full match, one projection
		t.Fatal(status, engine.Stats())
	}
	second, _ := compute(engine, "return 2", "return 4")
	if first.Key == second.Key || engine.Stats().Computations != 5 {
		t.Fatal("different snippets reparsed full file or reused projection", engine.Stats())
	}
	engine.Close()
	next := NewEngine(directory)
	defer next.Close()
	again, status := compute(next, "return 1", "return 3")
	if status != "disk" || again.Key != first.Key || next.Stats().Computations != 0 || next.Stats().DiskHits != 4 {
		t.Fatal("file documents, match and projection did not survive restart", status, next.Stats())
	}
	// The same complete before file must also be reused for another revision pair.
	third := strings.Replace(after, "return 4", "return 5", 1)
	if _, _, err := next.StructureWithContext(t.Context(), "return 2", "return 5", "go", contextWindow(t, before, "return 2"), contextWindow(t, third, "return 5")); err != nil || next.Stats().Computations != 3 {
		t.Fatal("shared source identity was parsed again", err, next.Stats())
	}
}
func TestStructureContextKeyBindsBothRangesAndSourceIdentities(t *testing.T) {
	engine := NewEngine("")
	defer engine.Close()
	code := "function one(){return 1;} function two(){return 1;}"
	keys := map[string]bool{}
	for _, name := range []string{"one", "two"} {
		start := strings.Index(code, "function "+name)
		from := start + strings.Index(code[start:], "return 1")
		a := &StructureContext{Code: code, From: from, To: from + len("return 1")}
		for _, b := range []*StructureContext{a, contextWindow(t, "// changed source identity\n"+code, "return 1")} {
			raw, _, err := engine.StructureWithContext(t.Context(), "return 1", "return 1", "js", a, b)
			var result StructureResult
			if err != nil || json.Unmarshal(raw, &result) != nil || keys[result.Key] {
				t.Fatal("projection key collided", result.Key, err)
			}
			keys[result.Key] = true
		}
	}
}
func TestStructureContextConcurrentOneWorkerHasNoNestedPoolWait(t *testing.T) {
	previous := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(previous)
	engine := NewEngine("")
	defer engine.Close()
	before := "package p\n"
	for i := 0; i < 8; i++ {
		before += fmt.Sprintf("func f%d(){return %d}\n", i, i)
	}
	after := strings.Replace(before, "return 0", "return 9", 1)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		old := fmt.Sprintf("func f%d(){return %d}", i, i)
		current := old
		if i == 0 {
			current = "func f0(){return 9}"
		}
		a, b := contextWindow(t, before, old), contextWindow(t, after, current)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := engine.StructureWithContext(ctx, old, current, "go", a, b); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if engine.Stats().Computations != 11 {
		t.Fatal("concurrent snippets duplicated full computation", engine.Stats())
	}
}

func TestStructureContextCancellationAndClosedEngine(t *testing.T) {
	engine := NewEngine("")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	a := &StructureContext{Code: "func f(){}", To: len("func f(){}")}
	if _, _, err := engine.StructureWithContext(ctx, a.Code, a.Code, "go", a, a); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := ComputeStructureWithContext(ctx, a.Code, a.Code, "go", a, a); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	engine.Close()
	if _, _, err := engine.StructureWithContext(t.Context(), a.Code, a.Code, "go", a, a); err != ErrClosed {
		t.Fatal(err)
	}
}

// These cases require the companion parser-budget change, without relaxing Diff.
func TestStructureContextLargeFullSource(t *testing.T) {
	for _, sample := range []struct{ name, padding string }{
		{"utf16", "/*" + strings.Repeat("x", 120000) + "*/\n"},
		{"lines", strings.Repeat("// padding\n", 2200)},
		{"tokens", "func padding(){" + strings.Repeat(";", 130000) + "}\n"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			before := "package p\n" + sample.padding + "func f(){if ok {return 1}}\n"
			after := strings.Replace(before, "return 1", "return 2", 1)
			old, current := "if ok {return 1", "if ok {return 2"
			a, b := contextWindow(t, before, old), contextWindow(t, after, current)
			if sample.name != "tokens" {
				if _, err := ComputeDiff(t.Context(), before, after, "go"); err == nil {
					t.Fatal("ordinary diff's 100k/2000-line boundary changed")
				}
			}
			engine := NewEngine(t.TempDir())
			defer engine.Close()
			raw, _, err := engine.StructureWithContext(t.Context(), old, current, "go", a, b)
			var result StructureResult
			if err != nil || json.Unmarshal(raw, &result) != nil || result.Mode != "structural" || len(result.Highlights.After) == 0 {
				t.Fatal("large complete file did not yield snippet structure (requires parser-budget integration)", result.Mode, result.Reason, err)
			}
			assertProjected(t, result, old, current)
			if stats := engine.Stats(); stats.MemoryBytes > memoryBudget || stats.Computations != 4 {
				t.Fatal(stats)
			}
		})
	}
}

func TestStructureContextOutsideStatementDoesNotColorAdjacentSnippet(t *testing.T) {
	before := "package p\nfunc f(){work(); tail()}\n"
	after := strings.Replace(before, "tail()", "added(); tail()", 1)
	saved := "work();"
	result, err := ComputeStructureWithContext(t.Context(), saved, saved, "go", contextWindow(t, before, saved), contextWindow(t, after, saved))
	if err != nil || result.Mode != "structural" || len(result.Highlights.Before)+len(result.Highlights.After) != 0 {
		t.Fatal("outside statement colored adjacent saved text", result, err)
	}
}
