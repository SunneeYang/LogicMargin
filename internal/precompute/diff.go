package precompute

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"
)

// These deterministic limits are part of myers-lines-runes-v1's cache identity.
const (
	diffMaxUTF16     = 100_000
	diffMaxLines     = 2_000
	diffMaxDistance  = 512
	diffSearchBudget = 2_000_000
)

type diffText struct {
	source      Source
	runes       []rune
	utf16       []int
	lines       []int
	lineOffsets []int
}

// ComputeDiff compares saved LF source text; it never reads files or sets cache keys.
func ComputeDiff(ctx context.Context, before, after, language string) (DiffResult, error) {
	if err := ctx.Err(); err != nil {
		return DiffResult{}, err
	}
	lineIDs := make(map[string]int)
	a, err := readDiffText(before, lineIDs)
	if err != nil {
		return DiffResult{}, fmt.Errorf("before: %w", err)
	}
	b, err := readDiffText(after, lineIDs)
	if err != nil {
		return DiffResult{}, fmt.Errorf("after: %w", err)
	}
	result := DiffResult{
		SchemaVersion: SchemaVersion, Algorithm: DiffAlgorithm, Language: language,
		Coordinate: "utf16", Before: a.source, After: b.source,
		Precise: true, Changes: make([]Change, 0),
	}
	budget := diffBudget{ctx: ctx, remaining: diffSearchBudget}
	lineChanges, precise := diffSequence(a.lines, b.lines, &budget)
	result.Precise = precise
	for _, lineChange := range lineChanges {
		fromA, toA := a.lineOffsets[lineChange.FromA], a.lineOffsets[lineChange.ToA]
		fromB, toB := b.lineOffsets[lineChange.FromB], b.lineOffsets[lineChange.ToB]
		changes, exact := diffSequence(a.runes[fromA:toA], b.runes[fromB:toB], &budget)
		result.Precise = result.Precise && exact
		for _, change := range changes {
			change = Change{
				FromA: a.utf16[fromA+change.FromA], ToA: a.utf16[fromA+change.ToA],
				FromB: b.utf16[fromB+change.FromB], ToB: b.utf16[fromB+change.ToB],
			}
			result.Changes = appendDiffChange(result.Changes, change)
		}
	}
	if err := ctx.Err(); err != nil {
		return DiffResult{}, err
	}
	return result, nil
}

func readDiffText(text string, lineIDs map[string]int) (diffText, error) {
	return readDiffTextWithLimits(text, lineIDs, diffMaxUTF16, diffMaxLines)
}

func readDiffTextWithLimits(text string, lineIDs map[string]int, maxUTF16, maxLines int) (diffText, error) {
	// A valid BMP rune uses at most three UTF-8 bytes per UTF-16 unit.
	if len(text) > 3*maxUTF16 || !utf8.ValidString(text) {
		return diffText{}, fmt.Errorf("source must be valid UTF-8 within %d UTF-16 units", maxUTF16)
	}
	length, lines := 0, 1
	for i, r := range text {
		if r == 0 || r == '\r' && i+1 < len(text) && text[i+1] == '\n' {
			return diffText{}, fmt.Errorf("source must use LF and contain no NUL")
		}
		length++
		if r > 0xffff {
			length++
		}
		if r == '\n' {
			lines++
		}
		if length > maxUTF16 || lines > maxLines {
			return diffText{}, fmt.Errorf("source exceeds %d UTF-16 units or %d lines", maxUTF16, maxLines)
		}
	}
	digest := sha256.Sum256([]byte(text))
	result := diffText{
		source: Source{Digest: hex.EncodeToString(digest[:]), Length: length},
		runes:  []rune(text), lines: make([]int, 0, lines), lineOffsets: make([]int, 0, lines+1),
	}
	result.utf16 = make([]int, len(result.runes)+1)
	for i, r := range result.runes {
		result.utf16[i+1] = result.utf16[i] + 1
		if r > 0xffff {
			result.utf16[i+1]++
		}
	}
	offset := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		id, ok := lineIDs[line]
		if !ok {
			id = len(lineIDs)
			lineIDs[line] = id
		}
		result.lines = append(result.lines, id)
		result.lineOffsets = append(result.lineOffsets, offset)
		offset += utf8.RuneCountInString(line)
	}
	result.lineOffsets = append(result.lineOffsets, offset)
	return result, nil
}

type diffBudget struct {
	ctx       context.Context
	remaining int
}

func (b *diffBudget) step() bool {
	if b.remaining == 0 {
		return false
	}
	b.remaining--
	return b.remaining&1023 != 0 || b.ctx.Err() == nil
}

// diffSequence returns indices in the supplied sequences. Prefix/suffix trimming
// is linear; the shared budget bounds frontier visits and equality scans.
func diffSequence[T comparable](a, b []T, budget *diffBudget) ([]Change, bool) {
	prefix, endA, endB := 0, len(a), len(b)
	for prefix < endA && prefix < endB {
		if prefix&1023 == 0 && budget.ctx.Err() != nil {
			return nil, false
		}
		if a[prefix] != b[prefix] {
			break
		}
		prefix++
	}
	for endA > prefix && endB > prefix {
		if (len(a)-endA)&1023 == 0 && budget.ctx.Err() != nil {
			return nil, false
		}
		if a[endA-1] != b[endB-1] {
			break
		}
		endA--
		endB--
	}
	if prefix == endA && prefix == endB {
		return nil, true
	}
	coarse := []Change{{FromA: prefix, ToA: endA, FromB: prefix, ToB: endB}}
	if prefix == endA || prefix == endB {
		return coarse, true
	}
	a, b = a[prefix:endA], b[prefix:endB]
	limit := min(len(a)+len(b), diffMaxDistance)
	// Only parity-compatible diagonals are retained: at most 131841 ints (about 1 MiB).
	trace := make([][]int, 0, limit+1)
	for distance := 0; distance <= limit; distance++ {
		if budget.ctx.Err() != nil {
			return nil, false
		}
		row := make([]int, distance+1)
		for i := range row {
			if !budget.step() {
				return coarse, false
			}
			x := 0
			if distance > 0 {
				previous := trace[distance-1]
				if i == 0 || i < distance && previous[i-1] < previous[i] {
					x = previous[i]
				} else {
					x = previous[i-1] + 1
				}
			}
			y := x - (2*i - distance)
			for x < len(a) && y < len(b) {
				if !budget.step() {
					return coarse, false
				}
				if a[x] != b[y] {
					break
				}
				x++
				y++
			}
			row[i] = x
			if x == len(a) && y == len(b) {
				trace = append(trace, row)
				return traceDiff(trace, len(a), len(b), prefix), true
			}
		}
		trace = append(trace, row)
	}
	return coarse, false
}

func traceDiff(trace [][]int, x, y, prefix int) []Change {
	changes := make([]Change, 0, len(trace)-1)
	for distance := len(trace) - 1; distance > 0; distance-- {
		i := (x - y + distance) / 2
		previous := trace[distance-1]
		var change Change
		if i == 0 || i < distance && previous[i-1] < previous[i] {
			x = previous[i]
			y = x - (2*i - distance + 1)
			change = Change{FromA: x + prefix, ToA: x + prefix, FromB: y + prefix, ToB: y + prefix + 1}
		} else {
			x = previous[i-1]
			y = x - (2*i - distance - 1)
			change = Change{FromA: x + prefix, ToA: x + prefix + 1, FromB: y + prefix, ToB: y + prefix}
		}
		changes = append(changes, change)
	}
	for i, j := 0, len(changes)-1; i < j; i, j = i+1, j-1 {
		changes[i], changes[j] = changes[j], changes[i]
	}
	merged := changes[:0]
	for _, change := range changes {
		merged = appendDiffChange(merged, change)
	}
	return merged
}

func appendDiffChange(changes []Change, change Change) []Change {
	if n := len(changes); n > 0 && changes[n-1].ToA == change.FromA && changes[n-1].ToB == change.FromB {
		changes[n-1].ToA, changes[n-1].ToB = change.ToA, change.ToB
		return changes
	}
	return append(changes, change)
}
