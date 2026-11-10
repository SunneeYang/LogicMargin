package precompute

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"logicmargin/internal/structure"
)

// ComputeStructureWithContext never reads source from disk or repairs saved text.
func ComputeStructureWithContext(ctx context.Context, before, after, language string, a, b *StructureContext) (result StructureResult, err error) {
	if a == nil || b == nil {
		return ComputeStructure(ctx, before, after, language)
	}
	work, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	base, err := contextStructureBase(work, before, after, language, *a, *b)
	if err != nil {
		return base, err
	}
	defer func() {
		if err != nil {
			if callerErr := ctx.Err(); callerErr != nil {
				err = callerErr
			} else if errors.Is(err, context.DeadlineExceeded) {
				result, err = structureFallback(base, "budget"), nil
			}
		}
	}()
	full, err := computeStructure(work, a.Code, b.Code, language, structureMaxUTF16, structureMaxLines)
	if err != nil {
		return base, err
	}
	return projectStructure(base, full, *a, *b), work.Err()
}

// Each complete source is parsed once per language and parser/matcher version,
// even when different snippet pairs or file revisions need the same document.
type structureDocumentArtifact struct {
	SchemaVersion int                `json:"schemaVersion"`
	Algorithm     string             `json:"algorithm"`
	Key           string             `json:"key"`
	Document      structure.Document `json:"document"`
	Reason        string             `json:"reason,omitempty"`
}

func (e *Engine) structureDocument(ctx context.Context, code, language string) (json.RawMessage, error) {
	key := artifactKey(StructureAlgorithm()+"-document", []string{language, artifactDigest([]byte(code))})
	raw, _, err := e.getStructure(ctx, key, len(code), func(ctx context.Context) ([]byte, error) {
		doc, err := structure.Parse(ctx, code, language)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		value := structureDocumentArtifact{SchemaVersion: SchemaVersion, Algorithm: StructureAlgorithm(), Key: key, Document: doc}
		if err != nil {
			value.Reason = structureReason(err)
		}
		return json.Marshal(value)
	})
	return raw, err
}

func (e *Engine) StructureWithContext(ctx context.Context, before, after, language string, a, b *StructureContext) (raw json.RawMessage, status string, err error) {
	if a == nil || b == nil {
		return e.Structure(ctx, before, after, language)
	}
	// Freeze caller-owned ranges before queuing work.
	leftContext, rightContext := *a, *b
	work, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	base, err := contextStructureBase(work, before, after, language, leftContext, rightContext)
	if err != nil {
		return nil, "", err
	}
	fullKey := artifactKey(StructureAlgorithm()+"-full", []string{language, artifactDigest([]byte(leftContext.Code)), artifactDigest([]byte(rightContext.Code))})
	key := artifactKey(StructureAlgorithm()+"-projection", []any{fullKey, base.Before.Digest, base.After.Digest, leftContext.From, leftContext.To, rightContext.From, rightContext.To})
	base.Key = key
	defer func() {
		if err == nil {
			return
		}
		if callerErr := ctx.Err(); callerErr != nil {
			raw, status, err = nil, "", callerErr
		} else if errors.Is(err, context.DeadlineExceeded) {
			if e.ctx.Err() != nil {
				raw, status, err = nil, "", ErrClosed
				return
			}
			// A wait deadline must not overwrite shared work that can still succeed.
			raw, err = json.Marshal(structureFallback(base, "budget"))
			status = "miss"
		}
	}()
	// Dependencies are obtained on the caller, never by a worker waiting on its pool.
	left, err := e.structureDocument(work, leftContext.Code, language)
	if err != nil {
		return nil, "", err
	}
	right := left
	if leftContext.Code != rightContext.Code {
		right, err = e.structureDocument(work, rightContext.Code, language)
	}
	if err != nil {
		return nil, "", err
	}
	full, _, err := e.getStructure(work, fullKey, len(leftContext.Code)+len(rightContext.Code)+len(left)+len(right), func(ctx context.Context) ([]byte, error) {
		var a, b structureDocumentArtifact
		if err := json.Unmarshal(left, &a); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(right, &b); err != nil {
			return nil, err
		}
		result, x, y, err := structureBaseWithLimits(leftContext.Code, rightContext.Code, language, structureMaxUTF16, structureMaxLines)
		if err != nil {
			return nil, err
		}
		result.Algorithm, result.Key = StructureAlgorithm(), fullKey
		if a.Reason != "" {
			result = structureFallback(result, a.Reason)
		} else if b.Reason != "" {
			result = structureFallback(result, b.Reason)
		} else {
			budget, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			result, err = analyzeDocuments(budget, result, x, y, a.Document, b.Document)
		}
		if err != nil {
			return nil, err
		}
		return json.Marshal(result)
	})
	if err != nil {
		return nil, "", err
	}
	return e.getStructure(work, key, len(full)+len(before)+len(after), func(ctx context.Context) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var result StructureResult
		if err := json.Unmarshal(full, &result); err != nil {
			return nil, err
		}
		result = projectStructure(base, result, leftContext, rightContext)
		result.Key = key
		return json.Marshal(result)
	})
}

func contextStructureBase(ctx context.Context, before, after, language string, a, b StructureContext) (StructureResult, error) {
	if err := ctx.Err(); err != nil {
		return StructureResult{}, err
	}
	base, _, _, err := structureBase(before, after, language)
	base.Algorithm = StructureAlgorithm()
	if err != nil {
		return base, err
	}
	if err := validateStructureContext(before, a); err != nil {
		return base, fmt.Errorf("before context: %w", err)
	}
	if err := validateStructureContext(after, b); err != nil {
		return base, fmt.Errorf("after context: %w", err)
	}
	return base, nil
}

func validateStructureContext(saved string, value StructureContext) error {
	if value.From < 0 || value.To < value.From || len(value.Code) > 3*structureMaxUTF16 || !utf8.ValidString(value.Code) {
		return fmt.Errorf("invalid source or UTF-16 range")
	}
	from, to, units, lines := -1, -1, 0, 1
	for i, r := range value.Code {
		if units == value.From {
			from = i
		}
		if units == value.To {
			to = i
		}
		if r == 0 || r == '\r' && i+1 < len(value.Code) && value.Code[i+1] == '\n' {
			return fmt.Errorf("source must use LF and contain no NUL")
		}
		units++
		if r > 0xffff {
			units++
		}
		if r == '\n' {
			lines++
		}
		if units > structureMaxUTF16 || lines > structureMaxLines {
			return fmt.Errorf("source exceeds %d UTF-16 units or %d lines", structureMaxUTF16, structureMaxLines)
		}
	}
	if units == value.From {
		from = len(value.Code)
	}
	if units == value.To {
		to = len(value.Code)
	}
	if from < 0 || to < from || value.Code[from:to] != saved {
		return fmt.Errorf("range must exactly match saved source at UTF-16 boundaries")
	}
	return nil
}

func projectRanges(ranges []CodeRange, window StructureContext) []CodeRange {
	out := []CodeRange{}
	for _, r := range ranges {
		out = appendHighlight(out, CodeRange{max(window.From, r.From) - window.From, min(window.To, r.To) - window.From})
	}
	return out
}
func projectScope(pair ScopePair, a, b StructureContext) (ScopePair, bool) {
	if pair.Before.From < a.From || pair.Before.To > a.To || pair.After.From < b.From || pair.After.To > b.To {
		return ScopePair{}, false
	}
	pair.Before = CodeRange{pair.Before.From - a.From, pair.Before.To - a.From}
	pair.After = CodeRange{pair.After.From - b.From, pair.After.To - b.From}
	return pair, true
}
func projectStructure(base, full StructureResult, a, b StructureContext) StructureResult {
	base.Mode, base.Reason, base.ParsedAs = full.Mode, full.Reason, full.ParsedAs
	if full.Mode != "structural" {
		return base
	}
	base.Highlights = Highlights{projectRanges(full.Highlights.Before, a), projectRanges(full.Highlights.After, b)}
	for _, scope := range full.Scopes {
		if pair, ok := projectScope(scope, a, b); ok {
			base.Scopes = append(base.Scopes, pair)
		}
	}
	for _, move := range full.Moves {
		if pair, ok := projectScope(move.ScopePair, a, b); ok {
			move.ScopePair = pair
			base.Moves = append(base.Moves, move)
		} else {
			// A clipped or one-sided move has no card; retain every visible byte.
			base.Highlights.Before = append(base.Highlights.Before, projectRanges([]CodeRange{move.Before}, a)...)
			base.Highlights.After = append(base.Highlights.After, projectRanges([]CodeRange{move.After}, b)...)
		}
	}
	base.Highlights.Before = normalizeHighlights(base.Highlights.Before)
	base.Highlights.After = normalizeHighlights(base.Highlights.After)
	base.FormattingOnly = base.Before.Digest != base.After.Digest && full.FormattingOnly && len(base.Highlights.Before)+len(base.Highlights.After)+len(base.Moves) == 0
	return base
}
