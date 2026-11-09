package precompute

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func TestComputeDiffRanges(t *testing.T) {
	for _, tc := range []struct {
		name, before, after string
		want                []Change
	}{
		{"empty", "", "", []Change{}},
		{"equal", "中文😀\ne\u0301", "中文😀\ne\u0301", []Change{}},
		{"insert", "abcd", "abXYcd", []Change{{2, 2, 2, 4}}},
		{"delete", "abXYcd", "abcd", []Change{{2, 4, 2, 2}}},
		{"replace", "abcd", "aXYd", []Change{{1, 3, 1, 3}}},
		{"empty-before", "", "中文😀", []Change{{0, 0, 0, 4}}},
		{"empty-after", "中文😀", "", []Change{{0, 4, 0, 0}}},
		{"insert-eof", "abc", "abcX", []Change{{3, 3, 3, 4}}},
		{"delete-eof", "abcX", "abc", []Change{{3, 4, 3, 3}}},
		{"final-newline", "abc", "abc\n", []Change{{3, 3, 3, 4}}},
		{"remove-final-newline", "abc\n", "abc", []Change{{3, 4, 3, 3}}},
		{"empty-lines", "\n", "\n\n", []Change{{1, 1, 1, 2}}},
		{"chinese", "前旧后", "前新后", []Change{{1, 2, 1, 2}}},
		{"emoji", "a😀b", "a🧪b", []Change{{1, 3, 1, 3}}},
		{"emoji-insert", "a中", "a😀中", []Change{{1, 1, 1, 3}}},
		{"emoji-delete", "😀中", "中", []Change{{0, 2, 0, 0}}},
		{"combining-mark", "Ae\u0301Z", "Ae\u0300Z", []Change{{2, 3, 2, 3}}},
		{"adjacent-edits", "abc123def456ghi", "abcXYdefZWghi", []Change{{3, 6, 3, 5}, {9, 12, 8, 10}}},
		{"multiple-lines", "start\naaa\nmiddle\nbbb\nend", "start\nZZZ\nmiddle\nYYY\nend", []Change{{6, 9, 6, 9}, {17, 20, 17, 20}}},
		{"standalone-cr", "a\rb", "a\rc", []Change{{2, 3, 2, 3}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := checkedDiff(t, tc.before, tc.after)
			if !result.Precise || !reflect.DeepEqual(result.Changes, tc.want) {
				t.Fatalf("got precise=%v changes=%+v; want %+v", result.Precise, result.Changes, tc.want)
			}
		})
	}
}

func TestComputeDiffMetadata(t *testing.T) {
	before, after := "中文😀\ne\u0301", "中文🧪\ne\u0301"
	result, err := ComputeDiff(context.Background(), before, after, "typescript")
	if err != nil {
		t.Fatal(err)
	}
	if result.SchemaVersion != 1 || result.Algorithm != "myers-lines-runes-v1" || result.Key != "" || result.Language != "typescript" || result.Coordinate != "utf16" {
		t.Fatalf("metadata: %+v", result)
	}
	for i, text := range []string{before, after} {
		want := sha256.Sum256([]byte(text))
		got := []Source{result.Before, result.After}[i]
		if got.Digest != hex.EncodeToString(want[:]) || got.Length != len(utf16.Encode([]rune(text))) {
			t.Fatalf("source metadata: %+v", got)
		}
	}
}

func TestComputeDiffRejectsInvalidSources(t *testing.T) {
	for name, text := range map[string]string{
		"crlf": "a\r\nb", "nul": "a\x00b", "utf8": "a\xffb",
		"utf16-limit": strings.Repeat("x", 100_001),
		"emoji-limit": strings.Repeat("😀", 50_001),
		"byte-limit":  strings.Repeat("中", 100_001),
		"line-limit":  strings.Repeat("\n", 2_000),
	} {
		for _, side := range []string{"before", "after"} {
			t.Run(name+"/"+side, func(t *testing.T) {
				before, after := text, ""
				if side == "after" {
					before, after = after, before
				}
				if _, err := ComputeDiff(context.Background(), before, after, ""); err == nil || !strings.HasPrefix(err.Error(), side+": ") {
					t.Fatalf("expected %s validation error, got %v", side, err)
				}
			})
		}
	}
}

func TestComputeDiffLimitsAndLargeEdits(t *testing.T) {
	t.Run("100k-2000-lines-small-edit", func(t *testing.T) {
		before := strings.Repeat(strings.Repeat("x", 49)+"\n", 1_999) + strings.Repeat("x", 50)
		after := before[:99_999] + "y"
		result := checkedDiff(t, before, after)
		if !result.Precise || !reflect.DeepEqual(result.Changes, []Change{{99_999, 100_000, 99_999, 100_000}}) {
			t.Fatalf("large small edit: %+v", result.Changes)
		}
	})
	t.Run("100k-utf16-emoji", func(t *testing.T) {
		before := strings.Repeat("😀", 50_000)
		after := strings.Repeat("😀", 24_999) + "🧪" + strings.Repeat("😀", 25_000)
		result := checkedDiff(t, before, after)
		if !result.Precise || !reflect.DeepEqual(result.Changes, []Change{{49_998, 50_000, 49_998, 50_000}}) {
			t.Fatalf("large emoji edit: %+v", result.Changes)
		}
	})
	t.Run("100k-three-byte-bmp", func(t *testing.T) {
		before := strings.Repeat("中", 100_000)
		result := checkedDiff(t, before, before)
		if !result.Precise || len(result.Changes) != 0 {
			t.Fatalf("maximum UTF-8 byte length: %+v", result)
		}
	})
	t.Run("large-delete", func(t *testing.T) {
		result := checkedDiff(t, strings.Repeat("x", 99_996)+"tail", "tail")
		if !result.Precise || !reflect.DeepEqual(result.Changes, []Change{{0, 99_996, 0, 0}}) {
			t.Fatalf("large deletion: %+v", result)
		}
	})
	t.Run("near-complete-replacement", func(t *testing.T) {
		before := "prefix\n" + strings.Repeat("x", 99_988) + "\ntail"
		after := "prefix\n" + strings.Repeat("y", 99_988) + "\ntail"
		result := checkedDiff(t, before, after)
		if result.Precise || !reflect.DeepEqual(result.Changes, []Change{{7, 99_995, 7, 99_995}}) {
			t.Fatalf("expected trimmed coarse replacement, got %+v", result)
		}
	})
	t.Run("2000-unrelated-lines", func(t *testing.T) {
		result := checkedDiff(t, strings.Repeat("old\n", 1_999)+"old", strings.Repeat("NEW\n", 1_999)+"NEW")
		if result.Precise {
			t.Fatal("expected bounded fallback")
		}
	})
	t.Run("many-local-edits", func(t *testing.T) {
		var a, b strings.Builder
		for i := range 1_000 {
			fmt.Fprintf(&a, "line %04d = old value\n", i)
			value := "old"
			if i%10 == 0 {
				value = "NEW"
			}
			fmt.Fprintf(&b, "line %04d = %s value\n", i, value)
		}
		result := checkedDiff(t, a.String(), b.String())
		if !result.Precise || len(result.Changes) != 100 {
			t.Fatalf("expected 100 precise local edits, got precise=%v count=%d", result.Precise, len(result.Changes))
		}
	})
}

func TestComputeDiffRepeatedLines(t *testing.T) {
	for _, pair := range [][2]string{
		{"start\nrepeat\nrepeat\nold\nrepeat\nend", "start\nrepeat\nrepeat\nrepeat\nnew\nrepeat\nend"},
		{"a\nx\na\nx\na\nx\nz", "a\nx\na\nx\nz"},
		{"a\nb\na\nb\na", "b\na\nb\na\nb"},
		{"\n\n\n中文😀\n\n", "\n\n😀\n中文\n\n"},
	} {
		result := checkedDiff(t, pair[0], pair[1])
		if !result.Precise {
			t.Fatal("small repeated-line diff should be precise")
		}
	}
}

func TestDiffSequenceBudget(t *testing.T) {
	a, b := []rune("same:abcdefgh:tail"), []rune("same:hgfedcba:tail")
	budget := diffBudget{ctx: context.Background(), remaining: 8}
	changes, precise := diffSequence(a, b, &budget)
	if precise || budget.remaining != 0 || !reflect.DeepEqual(changes, []Change{{5, 13, 5, 13}}) {
		t.Fatalf("budget fallback: precise=%v remaining=%d changes=%+v", precise, budget.remaining, changes)
	}
	// Exhaustion still trims equal context and handles pure insertions exactly.
	changes, precise = diffSequence([]rune("ab"), []rune("aXYb"), &budget)
	if !precise || !reflect.DeepEqual(changes, []Change{{1, 1, 1, 3}}) {
		t.Fatalf("insertion after exhaustion: precise=%v changes=%+v", precise, changes)
	}
}

func TestDiffSequenceScanBudget(t *testing.T) {
	a := []rune("X" + strings.Repeat("a", 99_998) + "b")
	b := []rune("Y" + strings.Repeat("a", 99_998) + "c")
	budget := diffBudget{ctx: context.Background(), remaining: 10_000}
	changes, precise := diffSequence(a, b, &budget)
	if precise || budget.remaining != 0 || !reflect.DeepEqual(changes, []Change{{0, 100_000, 0, 100_000}}) {
		t.Fatalf("scan fallback: precise=%v remaining=%d changes=%+v", precise, budget.remaining, changes)
	}
}

func TestDiffSequenceDistanceLimit(t *testing.T) {
	for _, size := range []int{diffMaxDistance / 2, diffMaxDistance/2 + 1} {
		before, after := strings.Repeat("x", size), strings.Repeat("y", size)
		result := checkedDiff(t, before, after)
		if result.Precise != (size*2 <= diffMaxDistance) {
			t.Fatalf("size=%d precise=%v", size, result.Precise)
		}
	}
}

func TestComputeDiffParallel(t *testing.T) {
	for i := range 8 {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Parallel()
			checkedDiff(t, "相同😀\nold\n", "相同🧪\nnew\n")
		})
	}
}

func TestComputeDiffCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ComputeDiff(ctx, "", "", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled: %v", err)
	}
	ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := ComputeDiff(ctx, "a", "b", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
	// Cancel on an in-search context check, independent of scheduler timing.
	midSearch := &diffCancelContext{Context: context.Background(), remaining: 12}
	if _, err := ComputeDiff(midSearch, strings.Repeat("x", 100_000), strings.Repeat("y", 100_000), ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("in-search cancellation: %v", err)
	}
}

type diffCancelContext struct {
	context.Context
	remaining int
}

func (c *diffCancelContext) Err() error {
	c.remaining--
	if c.remaining <= 0 {
		return context.Canceled
	}
	return nil
}

func TestComputeDiffRandomReconstruction(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	alphabet := []rune("aab中😀e\u0301\n{} ")
	for i := range 3_000 {
		a := make([]rune, rng.Intn(100))
		for j := range a {
			a[j] = alphabet[rng.Intn(len(alphabet))]
		}
		b := slices.Clone(a)
		for range 1 + rng.Intn(12) {
			from := rng.Intn(len(b) + 1)
			to := from + rng.Intn(len(b)-from+1)
			replacement := make([]rune, rng.Intn(8))
			for j := range replacement {
				replacement[j] = alphabet[rng.Intn(len(alphabet))]
			}
			b = slices.Replace(b, from, to, replacement...)
		}
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			checkedDiff(t, string(a), string(b))
		})
	}
}

func TestDiffSequenceShortestSmallEdits(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	alphabet := []rune("abc中😀")
	for range 2_000 {
		a, b := make([]rune, rng.Intn(30)), make([]rune, rng.Intn(30))
		for _, text := range [][]rune{a, b} {
			for j := range text {
				text[j] = alphabet[rng.Intn(len(alphabet))]
			}
		}
		budget := diffBudget{ctx: context.Background(), remaining: diffSearchBudget}
		changes, precise := diffSequence(a, b, &budget)
		cost, x, y := 0, 0, 0
		for _, change := range changes {
			if !slices.Equal(a[x:change.FromA], b[y:change.FromB]) {
				t.Fatalf("unequal gap: a=%q b=%q changes=%+v", string(a), string(b), changes)
			}
			cost += change.ToA - change.FromA + change.ToB - change.FromB
			x, y = change.ToA, change.ToB
		}
		// Independent edit-distance oracle, with two rows capped at 30 elements.
		row := make([]int, len(b)+1)
		for j := range row {
			row[j] = j
		}
		for i, r := range a {
			previous := row[0]
			row[0] = i + 1
			for j, s := range b {
				old := row[j+1]
				if r == s {
					row[j+1] = previous
				} else {
					row[j+1] = min(row[j], row[j+1]) + 1
				}
				previous = old
			}
		}
		if !precise || cost != row[len(b)] || !slices.Equal(a[x:], b[y:]) {
			t.Fatalf("a=%q b=%q cost=%d want=%d precise=%v changes=%+v", string(a), string(b), cost, row[len(b)], precise, changes)
		}
	}
}

func checkedDiff(t *testing.T, before, after string) DiffResult {
	t.Helper()
	result, err := ComputeDiff(context.Background(), before, after, "")
	if err != nil {
		t.Fatal(err)
	}
	checkDiffResult(t, before, after, result)
	return result
}

func checkDiffResult(t *testing.T, before, after string, result DiffResult) {
	t.Helper()
	a, b := utf16.Encode([]rune(before)), utf16.Encode([]rune(after))
	if result.Changes == nil || result.Before.Length != len(a) || result.After.Length != len(b) {
		t.Fatalf("missing changes or incorrect lengths: %+v", result)
	}
	x, y := 0, 0
	rebuilt := make([]uint16, 0, len(b))
	for _, c := range result.Changes {
		if c.FromA < x || c.FromB < y || c.ToA < c.FromA || c.ToB < c.FromB || c.ToA > len(a) || c.ToB > len(b) {
			t.Fatalf("unordered/out-of-bounds range: %+v (previous %d/%d)", c, x, y)
		}
		for _, boundary := range []struct {
			text []uint16
			at   int
		}{{a, c.FromA}, {a, c.ToA}, {b, c.FromB}, {b, c.ToB}} {
			if boundary.at > 0 && boundary.at < len(boundary.text) && boundary.text[boundary.at-1] >= 0xd800 && boundary.text[boundary.at-1] <= 0xdbff && boundary.text[boundary.at] >= 0xdc00 && boundary.text[boundary.at] <= 0xdfff {
				t.Fatalf("split surrogate pair: %+v", c)
			}
		}
		if slices.Equal(a[c.FromA:c.ToA], b[c.FromB:c.ToB]) {
			t.Fatalf("empty/unchanged change: %+v", c)
		}
		if !slices.Equal(a[x:c.FromA], b[y:c.FromB]) {
			t.Fatalf("unequal unchanged gap before %+v; a=%q b=%q", c, before, after)
		}
		rebuilt = append(rebuilt, a[x:c.FromA]...)
		rebuilt = append(rebuilt, b[c.FromB:c.ToB]...)
		x, y = c.ToA, c.ToB
	}
	if !slices.Equal(a[x:], b[y:]) {
		t.Fatalf("unequal unchanged tail; changes=%+v", result.Changes)
	}
	rebuilt = append(rebuilt, a[x:]...)
	if !slices.Equal(rebuilt, b) {
		t.Fatalf("failed reconstruction; changes=%+v", result.Changes)
	}
}

func FuzzComputeDiffReconstruction(f *testing.F) {
	for _, pair := range [][2]string{{"", ""}, {"中文😀\ne\u0301", "中文🧪\ne\u0300"}, {"a\nx\na\nx", "a\nx\nx\na"}} {
		f.Add(pair[0], pair[1])
	}
	f.Fuzz(func(t *testing.T, before, after string) {
		for _, text := range []string{before, after} {
			if !utf8.ValidString(text) || strings.Contains(text, "\r\n") || strings.ContainsRune(text, 0) || len(utf16.Encode([]rune(text))) > diffMaxUTF16 || strings.Count(text, "\n") >= diffMaxLines {
				t.Skip()
			}
		}
		checkedDiff(t, before, after)
	})
}

func BenchmarkComputeDiff(b *testing.B) {
	for _, tc := range []struct{ name, before, after string }{
		{"small-edit", "func check() { return oldValue }\n", "func check() { return newValue }\n"},
		{"100k-small-edit", strings.Repeat("x", 99_999) + "a", strings.Repeat("x", 99_999) + "b"},
		{"100k-unrelated", strings.Repeat("x", 100_000), strings.Repeat("y", 100_000)},
		{"100k-repeated-edits", strings.Repeat(strings.Repeat("a", 199)+"b", 500), strings.Repeat(strings.Repeat("a", 199)+"c", 500)},
		{"2000-unrelated-lines", strings.Repeat("old\n", 1_999) + "old", strings.Repeat("NEW\n", 1_999) + "NEW"},
	} {
		b.Run(tc.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := ComputeDiff(context.Background(), tc.before, tc.after, ""); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
