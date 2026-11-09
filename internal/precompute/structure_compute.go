package precompute

import (
	"context"
	"time"

	"logicmargin/internal/structure"
)

func StructureAlgorithm() string {
	return structureMatcherVersion + "-" + DiffAlgorithm + "-" + structure.Algorithm()
}

func ComputeStructure(ctx context.Context, before, after, language string) (StructureResult, error) {
	return computeStructure(ctx, before, after, language, diffMaxUTF16, diffMaxLines)
}

func computeStructure(ctx context.Context, before, after, language string, maxUTF16, maxLines int) (StructureResult, error) {
	if err := ctx.Err(); err != nil {
		return StructureResult{}, err
	}
	work, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	result, a, b, err := structureBaseWithLimits(before, after, language, maxUTF16, maxLines)
	if err != nil {
		return result, err
	}
	result.Algorithm = StructureAlgorithm()
	left, err := structure.Parse(work, before, language)
	if err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return structureFallback(result, structureReason(err)), nil
	}
	right := left
	if before != after {
		right, err = structure.Parse(work, after, language)
	}
	if err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return structureFallback(result, structureReason(err)), nil
	}
	analyzed, err := analyzeDocuments(work, result, a, b, left, right)
	if err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return structureFallback(result, structureReason(err)), nil
	}
	return analyzed, nil
}
