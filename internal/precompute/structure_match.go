package precompute

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode"

	"logicmargin/internal/structure"
)

const structureMatcherVersion = "structure-v1"
const maxStructureTokens = 40000
const maxStructureScopes = 256
const maxStructureMoves = 32

func structureID(parts ...any) string {
	raw, _ := json.Marshal(parts)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func structureBase(before, after, language string) (StructureResult, diffText, diffText, error) {
	a, err := readDiffText(before, map[string]int{})
	if err != nil {
		return StructureResult{}, a, diffText{}, err
	}
	b, err := readDiffText(after, map[string]int{})
	if err != nil {
		return StructureResult{}, a, b, err
	}
	result := StructureResult{SchemaVersion: SchemaVersion, Language: language, Coordinate: "utf16", Before: a.source, After: b.source, Mode: "text", Highlights: Highlights{Before: []CodeRange{}, After: []CodeRange{}}, Scopes: []ScopePair{}, Moves: []MovedCode{}}
	return result, a, b, nil
}
func structureFallback(result StructureResult, reason string) StructureResult {
	result.Mode, result.Reason, result.FormattingOnly = "text", reason, false
	result.Highlights = Highlights{Before: []CodeRange{}, After: []CodeRange{}}
	result.Scopes, result.Moves = []ScopePair{}, []MovedCode{}
	return result
}
func runeAt(text diffText, offset int) (int, bool) {
	index := sort.SearchInts(text.utf16, offset)
	return index, index < len(text.utf16) && text.utf16[index] == offset
}
func sourceRange(text diffText, r CodeRange) (string, bool) {
	from, ok := runeAt(text, r.From)
	if !ok {
		return "", false
	}
	to, ok := runeAt(text, r.To)
	if !ok || to < from {
		return "", false
	}
	return string(text.runes[from:to]), true
}
func validStructureDocument(text diffText, doc structure.Document) bool {
	if doc.Shape == "" || doc.ParsedAs == "" {
		return false
	}
	last := 0
	for _, token := range doc.Tokens {
		if token.Key == "" || token.From < last || token.To < token.From {
			return false
		}
		gap, ok := sourceRange(text, CodeRange{last, token.From})
		if !ok || strings.IndexFunc(gap, func(r rune) bool { return !unicode.IsSpace(r) }) >= 0 {
			return false
		}
		if _, ok := sourceRange(text, CodeRange{token.From, token.To}); !ok {
			return false
		}
		last = token.To
	}
	gap, ok := sourceRange(text, CodeRange{last, text.source.Length})
	if !ok || strings.IndexFunc(gap, func(r rune) bool { return !unicode.IsSpace(r) }) >= 0 {
		return false
	}
	scopes := append([]structure.Scope(nil), doc.Scopes...)
	sort.Slice(scopes, func(i, j int) bool { return scopes[i].From < scopes[j].From })
	last = 0
	for _, scope := range scopes {
		if scope.From < last || scope.To <= scope.From || scope.Kind == "" || scope.Name == "" || scope.Shape == "" {
			return false
		}
		if _, ok := sourceRange(text, CodeRange{scope.From, scope.To}); !ok {
			return false
		}
		last = scope.To
	}
	return true
}

// Go permits a semicolon before ) or }; retain all other statement boundaries.
func withoutOptionalGoSemicolons(tokens []structure.Token) []structure.Token {
	out := make([]structure.Token, 0, len(tokens))
	next := ""
	for i := len(tokens) - 1; i >= 0; i-- {
		token := tokens[i]
		optional := token.Boundary && token.Key == ";:;" && (next == "):)" || next == "}:}")
		if !optional {
			out = append(out, token)
		}
		if !strings.HasPrefix(token.Key, "COMMENT:") && !optional {
			next = token.Key
		}
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
func tokenKeys(tokens []structure.Token) []string {
	out := make([]string, len(tokens))
	for i, t := range tokens {
		out[i] = t.Key
	}
	return out
}
func equalTokenKeys(a, b []structure.Token) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Key != b[i].Key {
			return false
		}
	}
	return true
}
func tokensInScope(tokens []structure.Token, scope structure.Scope) []structure.Token {
	from := sort.Search(len(tokens), func(i int) bool { return tokens[i].To > scope.From || tokens[i].From >= scope.From })
	to := from
	for to < len(tokens) && tokens[to].From < scope.To {
		to++
	}
	return tokens[from:to]
}
func appendHighlight(ranges []CodeRange, r CodeRange) []CodeRange {
	if r.To > r.From {
		return append(ranges, r)
	}
	return ranges
}
func normalizeHighlights(ranges []CodeRange) []CodeRange {
	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i].From == ranges[j].From {
			return ranges[i].To < ranges[j].To
		}
		return ranges[i].From < ranges[j].From
	})
	out := []CodeRange{}
	for _, r := range ranges {
		if r.To <= r.From {
			continue
		}
		if len(out) > 0 && r.From <= out[len(out)-1].To {
			out[len(out)-1].To = max(out[len(out)-1].To, r.To)
		} else {
			out = append(out, r)
		}
	}
	return out
}
func meaningfulHighlights(ctx context.Context, a, b diffText, left, right []structure.Token, budget *diffBudget) (Highlights, string, error) {
	out := Highlights{Before: []CodeRange{}, After: []CodeRange{}}
	changes, precise := diffSequence(tokenKeys(left), tokenKeys(right), budget)
	if err := ctx.Err(); err != nil {
		return out, "", err
	}
	if !precise {
		return out, "budget", nil
	}
	for _, change := range changes {
		x, y := left[change.FromA:change.ToA], right[change.FromB:change.ToB]
		for _, tokens := range [][]structure.Token{x, y} {
			for _, t := range tokens {
				if t.Boundary {
					return out, "syntax-boundary", nil
				}
			}
		}
		if len(x) == 1 && len(y) == 1 {
			before, _ := sourceRange(a, CodeRange{x[0].From, x[0].To})
			after, _ := sourceRange(b, CodeRange{y[0].From, y[0].To})
			aa, err := readDiffText(before, map[string]int{})
			if err != nil {
				return out, "syntax-boundary", nil
			}
			bb, err := readDiffText(after, map[string]int{})
			if err != nil {
				return out, "syntax-boundary", nil
			}
			refined, precise := diffSequence(aa.runes, bb.runes, budget)
			if !precise {
				return out, "budget", nil
			}
			for _, r := range refined {
				out.Before = appendHighlight(out.Before, CodeRange{x[0].From + aa.utf16[r.FromA], x[0].From + aa.utf16[r.ToA]})
				out.After = appendHighlight(out.After, CodeRange{y[0].From + bb.utf16[r.FromB], y[0].From + bb.utf16[r.ToB]})
			}
		} else {
			for _, t := range x {
				out.Before = appendHighlight(out.Before, CodeRange{t.From, t.To})
			}
			for _, t := range y {
				out.After = appendHighlight(out.After, CodeRange{t.From, t.To})
			}
		}
	}
	return out, "", ctx.Err()
}

type matchedScope struct {
	before, after    structure.Scope
	pair             ScopePair
	moved, ambiguous bool
}

func scopeKey(scope structure.Scope) string { return scope.Kind + "\x00" + scope.Name }
func scopeBodyID(text diffText, tokens []structure.Token, scope structure.Scope) string {
	keys := []string{}
	removedName := false
	name := scope.Name[strings.LastIndex(scope.Name, ".")+1:]
	for _, token := range tokensInScope(tokens, scope) {
		value, _ := sourceRange(text, CodeRange{token.From, token.To})
		if !removedName && value == name {
			removedName = true
			continue
		}
		keys = append(keys, token.Key)
	}
	return structureID(scope.Kind, keys)
}
func matchScopes(a, b diffText, left, right structure.Document) []matchedScope {
	groupsA, groupsB := map[string][]structure.Scope{}, map[string][]structure.Scope{}
	bodiesA, bodiesB := map[string]int{}, map[string]int{}
	for _, s := range left.Scopes {
		key := scopeKey(s)
		groupsA[key] = append(groupsA[key], s)
		bodiesA[scopeBodyID(a, left.Tokens, s)]++
	}
	for _, s := range right.Scopes {
		key := scopeKey(s)
		groupsB[key] = append(groupsB[key], s)
		bodiesB[scopeBodyID(b, right.Tokens, s)]++
	}
	pairs := []matchedScope{}
	for key, x := range groupsA {
		y := groupsB[key]
		if len(x) != 1 || len(y) != 1 {
			continue
		}
		old, current := x[0], y[0]
		pair := ScopePair{ID: structureID(a.source.Digest, b.source.Digest, key, old.From, old.To, current.From, current.To), Kind: old.Kind, Name: old.Name, Before: CodeRange{old.From, old.To}, After: CodeRange{current.From, current.To}}
		pairs = append(pairs, matchedScope{before: old, after: current, pair: pair, ambiguous: bodiesA[scopeBodyID(a, left.Tokens, old)] > 1 || bodiesB[scopeBodyID(b, right.Tokens, current)] > 1})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].before.From < pairs[j].before.From })
	// A line-number shift alone is not a move: retain a longest increasing scope order.
	lengths, previous := make([]int, len(pairs)), make([]int, len(pairs))
	best := -1
	for i := range pairs {
		lengths[i], previous[i] = 1, -1
		for j := 0; j < i; j++ {
			if pairs[j].after.From < pairs[i].after.From && lengths[j]+1 > lengths[i] {
				lengths[i], previous[i] = lengths[j]+1, j
			}
		}
		pairs[i].moved = true
		if best < 0 || lengths[i] > lengths[best] {
			best = i
		}
	}
	for best >= 0 {
		pairs[best].moved = false
		best = previous[best]
	}
	return pairs
}
func tokensOutsideScopes(tokens []structure.Token, scopes []CodeRange) []structure.Token {
	sort.Slice(scopes, func(i, j int) bool { return scopes[i].From < scopes[j].From })
	out := []structure.Token{}
	index := 0
	for _, token := range tokens {
		for index < len(scopes) && scopes[index].To <= token.From {
			index++
		}
		if index < len(scopes) && token.From >= scopes[index].From && token.To <= scopes[index].To {
			continue
		}
		out = append(out, token)
	}
	return out
}
func localHighlights(value Highlights, before, after int) Highlights {
	out := Highlights{Before: []CodeRange{}, After: []CodeRange{}}
	for _, r := range value.Before {
		out.Before = append(out.Before, CodeRange{r.From - before, r.To - before})
	}
	for _, r := range value.After {
		out.After = append(out.After, CodeRange{r.From - after, r.To - after})
	}
	return out
}

func analyzeDocuments(ctx context.Context, result StructureResult, a, b diffText, left, right structure.Document) (StructureResult, error) {
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if len(left.Tokens) > maxStructureTokens || len(right.Tokens) > maxStructureTokens || len(left.Scopes) > maxStructureScopes || len(right.Scopes) > maxStructureScopes {
		return structureFallback(result, "budget"), nil
	}
	if !validStructureDocument(a, left) || !validStructureDocument(b, right) {
		return structureFallback(result, "invalid-syntax"), nil
	}
	result.ParsedAs = &ParsedSources{left.ParsedAs, right.ParsedAs}
	if result.Language == "go" {
		left.Tokens = withoutOptionalGoSemicolons(left.Tokens)
		right.Tokens = withoutOptionalGoSemicolons(right.Tokens)
	}
	if equalTokenKeys(left.Tokens, right.Tokens) && left.Shape != right.Shape {
		return structureFallback(result, "syntax-boundary"), nil
	}
	budget := diffBudget{ctx: ctx, remaining: diffSearchBudget}
	pairs := matchScopes(a, b, left, right)
	moves := 0
	for _, pair := range pairs {
		if pair.moved && !pair.ambiguous {
			moves++
		}
	}
	if moves > maxStructureMoves {
		return structureFallback(result, "budget"), nil
	}
	oldRanges, newRanges := []CodeRange{}, []CodeRange{}
	local := map[string]Highlights{}
	for _, pair := range pairs {
		x, y := tokensInScope(left.Tokens, pair.before), tokensInScope(right.Tokens, pair.after)
		if equalTokenKeys(x, y) && pair.before.Shape != pair.after.Shape {
			return structureFallback(result, "syntax-boundary"), nil
		}
		value, reason, err := meaningfulHighlights(ctx, a, b, x, y, &budget)
		if err != nil {
			return result, err
		}
		if reason != "" {
			return structureFallback(result, reason), nil
		}
		local[pair.pair.ID] = value
		if !pair.moved || !pair.ambiguous {
			oldRanges = append(oldRanges, pair.pair.Before)
			newRanges = append(newRanges, pair.pair.After)
		}
	}
	highlights, reason, err := meaningfulHighlights(ctx, a, b, tokensOutsideScopes(left.Tokens, oldRanges), tokensOutsideScopes(right.Tokens, newRanges), &budget)
	if err != nil {
		return result, err
	}
	if reason != "" {
		return structureFallback(result, reason), nil
	}
	for _, pair := range pairs {
		value := local[pair.pair.ID]
		if !pair.moved || !pair.ambiguous {
			highlights.Before = append(highlights.Before, value.Before...)
			highlights.After = append(highlights.After, value.After...)
		}
		result.Scopes = append(result.Scopes, pair.pair)
		if !pair.moved || pair.ambiguous {
			continue
		}
		before, _ := sourceRange(a, pair.pair.Before)
		after, _ := sourceRange(b, pair.pair.After)
		comparison, err := ComputeDiff(ctx, before, after, result.Language)
		if err != nil {
			return result, err
		}
		comparison.Key = structureID(DiffAlgorithm, result.Language, comparison.Before.Digest, comparison.After.Digest)
		result.Moves = append(result.Moves, MovedCode{ScopePair: pair.pair, Modified: len(value.Before)+len(value.After) > 0, Highlights: localHighlights(value, pair.before.From, pair.after.From), Comparison: comparison})
	}
	result.Mode = "structural"
	result.FormattingOnly = a.source.Digest != b.source.Digest && equalTokenKeys(left.Tokens, right.Tokens) && left.Shape == right.Shape
	result.Highlights = Highlights{normalizeHighlights(highlights.Before), normalizeHighlights(highlights.After)}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	return result, nil
}

func structureReason(err error) string {
	if errors.Is(err, structure.ErrUnsupported) {
		return "unsupported-language"
	}
	if errors.Is(err, structure.ErrBudget) || errors.Is(err, context.DeadlineExceeded) {
		return "budget"
	}
	return "invalid-syntax"
}
