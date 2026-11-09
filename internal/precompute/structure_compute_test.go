package precompute

import (
	"context"
	"testing"
)

func TestStructureConservativeRelocations(t *testing.T) {
	for _, sample := range []struct{ name, before, after string }{
		{"control-flow", `if (enabled) { function f(){return 1;} use(f); } else {}`, `if (enabled) { use(f); } else { function f(){return 1;} }`},
		{"named-expression", `const one = function f(){return 1;}; const two = function g(){return 2;};`, `const one = function g(){return 2;}; const two = function f(){return 1;};`},
		{"export-reassociation", `export function a(){return 1;} function b(){return 2;}`, `function a(){return 1;} export function b(){return 2;}`},
	} {
		t.Run(sample.name, func(t *testing.T) {
			result, err := ComputeStructure(t.Context(), sample.before, sample.after, "js")
			if err != nil {
				t.Fatal(err)
			}
			if result.FormattingOnly || len(result.Moves) != 0 {
				t.Fatal("uncertain relocation suppressed text", result)
			}
			if result.Mode == "structural" && len(result.Highlights.Before)+len(result.Highlights.After) == 0 {
				t.Fatal("real modification hidden by paired scopes", result)
			}
		})
	}
}

func TestStructureFallbackAndCancellation(t *testing.T) {
	result, err := ComputeStructure(t.Context(), "old", "new", "txt")
	if err != nil || result.Mode != "text" || result.Reason != "unsupported-language" {
		t.Fatal(result, err)
	}
	result, err = ComputeStructure(t.Context(), "func cut(){", "func cut(){ return", "go")
	if err != nil || result.Mode != "text" || result.Reason != "invalid-syntax" {
		t.Fatal(result, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ComputeStructure(ctx, "old", "new", "ts"); err != context.Canceled {
		t.Fatal(err)
	}
}

func TestStructureGoOptionalSemicolons(t *testing.T) {
	imports, err := ComputeStructure(t.Context(), "package p; import (\"a\")", "package p\nimport (\n\"a\"\n)\n", "go")
	if err != nil || imports.Mode != "structural" || !imports.FormattingOnly {
		t.Fatal(imports, err)
	}
	before := "func check(n int) bool { return n<10 }"
	for _, after := range []string{"func check(n int) bool {\n return n < 10\n}", "func check(n int) bool { return n < 10; }"} {
		result, err := ComputeStructure(t.Context(), before, after, "go")
		if err != nil || result.Mode != "structural" || !result.FormattingOnly {
			t.Fatal(result, err)
		}
	}
	after := "func check(n int) bool {\n return n <= 10\n}"
	result, err := ComputeStructure(t.Context(), before, after, "go")
	if err != nil || result.Mode != "structural" || result.FormattingOnly || len(result.Highlights.After) != 1 {
		t.Fatal(result, err)
	}
	result, err = ComputeStructure(t.Context(), "func f(){ return x() }", "func f(){ return\nx() }", "go")
	if err != nil || result.Mode != "text" || result.Reason != "syntax-boundary" {
		t.Fatal(result, err)
	}
}
