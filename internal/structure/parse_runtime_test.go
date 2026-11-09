//go:build !race

package structure

import (
	"errors"
	"testing"
)

// Check the public production budget without race instrumentation's VM startup overhead.
func TestParseRuntimeBudget(t *testing.T) {
	for _, language := range []string{"go", "js", "mjs", "cjs", "jsx", "ts", "tsx"} {
		t.Run(language, func(t *testing.T) {
			source := "function F(){return 1;}"
			if language == "go" {
				source = "func F() int {return 1}"
			}
			doc, err := Parse(t.Context(), source, language)
			if err != nil {
				t.Fatalf("public Parse: %v", err)
			}
			checkCoverage(t, source, doc)
			if _, err := Parse(t.Context(), "function f( {", language); !errors.Is(err, ErrSyntax) {
				t.Fatalf("invalid source: %v, want ErrSyntax", err)
			}
		})
	}
}
