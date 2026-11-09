package precompute

import (
	"context"
	"encoding/json"
)

func (e *Engine) Diff(ctx context.Context, before, after, language string) (json.RawMessage, string, error) {
	key := artifactKey(DiffAlgorithm, []string{language, artifactDigest([]byte(before)), artifactDigest([]byte(after))})
	return e.get(ctx, key, len(before)+len(after), func(ctx context.Context) ([]byte, error) {
		result, err := ComputeDiff(ctx, before, after, language)
		if err != nil {
			return nil, err
		}
		result.Key = key
		return json.Marshal(result)
	})
}

func (e *Engine) Layout(ctx context.Context, input LayoutInput) (json.RawMessage, string, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, "", err
	}
	key := artifactKey(LayoutAlgorithm(), json.RawMessage(raw))
	return e.get(ctx, key, len(raw), func(ctx context.Context) ([]byte, error) {
		var frozen LayoutInput
		if err := json.Unmarshal(raw, &frozen); err != nil {
			return nil, err
		}
		result, err := ComputeLayout(ctx, frozen)
		if err != nil {
			return nil, err
		}
		result.Key = key
		return json.Marshal(result)
	})
}

func (e *Engine) Structure(ctx context.Context, before, after, language string) (json.RawMessage, string, error) {
	key := artifactKey(StructureAlgorithm(), []string{language, artifactDigest([]byte(before)), artifactDigest([]byte(after))})
	return e.getStructure(ctx, key, len(before)+len(after), func(ctx context.Context) ([]byte, error) {
		result, err := ComputeStructure(ctx, before, after, language)
		if err != nil {
			return nil, err
		}
		result.Key = key
		return json.Marshal(result)
	})
}
