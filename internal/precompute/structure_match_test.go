package precompute

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"

	"logicmargin/internal/structure"
)

// Matching tests supply parsed documents independently of the language adapters.
func matchDocument(source string, scopes ...string) structure.Document {
	d := structure.Document{Shape: "document", ParsedAs: "file", Tokens: []structure.Token{}, Scopes: []structure.Scope{}}
	units := func(s string) int { return len(utf16.Encode([]rune(s))) }
	for _, span := range regexp.MustCompile(`[A-Za-z_][A-Za-z_0-9]*|[0-9]+|<=|>=|==|!=|[^\s]`).FindAllStringIndex(source, -1) {
		value := source[span[0]:span[1]]
		d.Tokens = append(d.Tokens, structure.Token{From: units(source[:span[0]]), To: units(source[:span[1]]), Key: value, Boundary: value == ";"})
	}
	for _, name := range scopes {
		start := strings.Index(source, "func "+name+"(")
		end := start + strings.Index(source[start:], "}") + 1
		d.Scopes = append(d.Scopes, structure.Scope{Kind: "function", Name: name, From: units(source[:start]), To: units(source[:end]), Shape: "function"})
	}
	return d
}
func matchFixture(t *testing.T, before, after string, a, b structure.Document) StructureResult {
	t.Helper()
	base, x, y, err := structureBase(before, after, "go")
	if err != nil {
		t.Fatal(err)
	}
	result, err := analyzeDocuments(t.Context(), base, x, y, a, b)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestStructureFormattingAndFineChanges(t *testing.T) {
	before := "func check(n int) {return n<10}"
	after := "func check(n int) {\n return n < 10\n}"
	result := matchFixture(t, before, after, matchDocument(before, "check"), matchDocument(after, "check"))
	if result.Mode != "structural" || !result.FormattingOnly || len(result.Highlights.Before)+len(result.Highlights.After) != 0 {
		t.Fatal(result)
	}
	after = strings.Replace(after, "< 10", "<= 10", 1)
	result = matchFixture(t, before, after, matchDocument(before, "check"), matchDocument(after, "check"))
	if result.FormattingOnly || len(result.Highlights.Before) != 0 || len(result.Highlights.After) != 1 {
		t.Fatal(result)
	}
	_, doc, _, _ := structureBase(after, after, "go")
	value, ok := sourceRange(doc, result.Highlights.After[0])
	if !ok || value != "=" {
		t.Fatal(value, result)
	}
	equal := matchFixture(t, before, before, matchDocument(before, "check"), matchDocument(before, "check"))
	if equal.FormattingOnly {
		t.Fatal("identical code reported formatting change")
	}
}
func TestStructureMovedModifiedAndOffsetOnly(t *testing.T) {
	one := "func one() {return 1}\n"
	two := "func two() {return 2}\n"
	three := "func three() {return 3}\n"
	before := one + two + three
	after := strings.Replace(three, "3", "4", 1) + one + two
	result := matchFixture(t, before, after, matchDocument(before, "one", "two", "three"), matchDocument(after, "three", "one", "two"))
	if result.Mode != "structural" || len(result.Moves) != 1 || result.Moves[0].Name != "three" || !result.Moves[0].Modified {
		t.Fatal(result)
	}
	move := result.Moves[0]
	if move.Comparison.Before.Length != len(strings.TrimSuffix(three, "\n")) || len(move.Comparison.Changes) == 0 || move.Comparison.Key == "" {
		t.Fatal(move)
	}
	if len(move.Highlights.Before) != 1 || len(move.Highlights.After) != 1 {
		t.Fatal(move.Highlights)
	}
	shifted := "\n\n" + before
	result = matchFixture(t, before, shifted, matchDocument(before, "one", "two", "three"), matchDocument(shifted, "one", "two", "three"))
	if len(result.Moves) != 0 {
		t.Fatal("line shifts were labeled moves", result.Moves)
	}
	result = matchFixture(t, before, three+one+two, matchDocument(before, "one", "two", "three"), matchDocument(three+one+two, "three", "one", "two"))
	if len(result.Moves) != 1 || result.Moves[0].Modified || len(result.Highlights.Before)+len(result.Highlights.After) != 0 {
		t.Fatal(result)
	}
}
func TestStructureAmbiguityBoundariesAndBadRanges(t *testing.T) {
	before := "func one() {return 1}\nfunc two() {return 1}\n"
	after := "func two() {return 1}\nfunc one() {return 1}\n"
	result := matchFixture(t, before, after, matchDocument(before, "one", "two"), matchDocument(after, "two", "one"))
	if len(result.Moves) != 0 || result.FormattingOnly {
		t.Fatal("duplicate bodies forced a move", result)
	}
	before = "return x"
	after = "return; x"
	result = matchFixture(t, before, after, matchDocument(before), matchDocument(after))
	if result.Mode != "text" || result.Reason != "syntax-boundary" {
		t.Fatal(result)
	}
	before = "return x"
	after = "return\nx"
	a, b := matchDocument(before), matchDocument(after)
	b.Shape = "different-return-structure"
	result = matchFixture(t, before, after, a, b)
	if result.Mode != "text" || result.FormattingOnly {
		t.Fatal("changed parse hidden as whitespace", result)
	}
	a, b = matchDocument(before), matchDocument(before)
	a.Tokens[0].To = 10000
	result = matchFixture(t, before, before, a, b)
	if result.Mode != "text" {
		t.Fatal("invalid parser coordinate accepted", result)
	}
}
func TestStructureUnicodeCancellationAndBudget(t *testing.T) {
	before := "func f() {return \"😀\"}"
	after := "func f() {return \"😁\"}"
	result := matchFixture(t, before, after, matchDocument(before, "f"), matchDocument(after, "f"))
	_, a, b, err := structureBase(before, after, "go")
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range result.Highlights.Before {
		if _, ok := sourceRange(a, r); !ok {
			t.Fatal("split surrogate", r)
		}
	}
	for _, r := range result.Highlights.After {
		if _, ok := sourceRange(b, r); !ok {
			t.Fatal("split surrogate", r)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := analyzeDocuments(ctx, result, a, b, matchDocument(before, "f"), matchDocument(after, "f")); err != context.Canceled {
		t.Fatal(err)
	}
	budget := diffBudget{ctx: t.Context(), remaining: 0}
	_, reason, err := meaningfulHighlights(t.Context(), a, b, matchDocument(before).Tokens, matchDocument(after).Tokens, &budget)
	if err != nil || reason != "budget" {
		t.Fatal(reason, err)
	}
}

func TestStructureMoveLimitPreservesText(t *testing.T) {
	blocks, names := []string{}, []string{}
	for i := 0; i < maxStructureMoves+2; i++ {
		name := fmt.Sprintf("scope%d", i)
		names = append(names, name)
		blocks = append(blocks, fmt.Sprintf("func %s() {return %d}\n", name, i))
	}
	before := strings.Join(blocks, "")
	for i, j := 0, len(blocks)-1; i < j; i, j = i+1, j-1 {
		blocks[i], blocks[j] = blocks[j], blocks[i]
	}
	after := strings.Join(blocks, "")
	result := matchFixture(t, before, after, matchDocument(before, names...), matchDocument(after, names...))
	if result.Mode != "text" || result.Reason != "budget" || len(result.Moves) != 0 {
		t.Fatal("move limit must not hide omitted movements", result)
	}
}

func TestStructureScopeBudgetIsExplicit(t *testing.T) {
	source := "func only() {return 1}"
	doc := matchDocument(source, "only")
	for len(doc.Scopes) <= maxStructureScopes {
		doc.Scopes = append(doc.Scopes, doc.Scopes[0])
	}
	result := matchFixture(t, source, source, doc, doc)
	if result.Mode != "text" || result.Reason != "budget" {
		t.Fatal(result)
	}
}
