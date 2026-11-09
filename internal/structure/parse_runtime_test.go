//go:build !race

package structure

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
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

func TestLargeCompleteSources(t *testing.T) {
	for _, language := range []string{"go", "ts", "tsx"} {
		t.Run(language, func(t *testing.T) {
			var source strings.Builder
			if language == "go" {
				source.WriteString("package p\n")
			}
			for i := range 2_500 {
				if language == "go" {
					fmt.Fprintf(&source, "var item%04d = \"saved-source-entry-%04d-😀中文\"\n", i, i)
				} else {
					fmt.Fprintf(&source, "const item%04d: string = 'saved-source-entry-%04d-😀中文';\n", i, i)
				}
			}
			prefix := source.String()
			body := "function F(): string { return\nitem2499 }"
			if language == "go" {
				body = "func F() string { return\nitem2499 }"
			} else if language == "tsx" {
				body = "function F() { return\n<div>  😀中文 {item2499} </div> }"
			}
			text := prefix + body
			if units := len(utf16.Encode([]rune(text))); units <= 100_000 || units > maxSourceUnits {
				t.Fatalf("fixture outside larger source budget: %d", units)
			}
			doc, err := Parse(t.Context(), text, language)
			if err != nil {
				t.Fatalf("large complete %s source: %v", language, err)
			}
			checkCoverage(t, text, doc)
			if doc.ParsedAs != "file" || len(doc.Scopes) != 1 || doc.Scopes[0].From != len(utf16.Encode([]rune(prefix))) {
				t.Fatal("complete-file mode or UTF-16 scope coordinates changed")
			}
			joined, err := Parse(t.Context(), prefix+strings.Replace(body, "return\n", "return ", 1), language)
			if err != nil || reflect.DeepEqual(keys(doc), keys(joined)) || doc.Shape == joined.Shape {
				t.Fatalf("restricted newline disappeared: %v", err)
			}
			changed, err := Parse(t.Context(), strings.Replace(text, "😀中文", "😀中 文", 1), language)
			if err != nil || reflect.DeepEqual(keys(doc), keys(changed)) {
				t.Fatalf("saved literal content disappeared: %v", err)
			}
			if _, err := Parse(t.Context(), text+"\n}", language); !errors.Is(err, ErrSyntax) {
				t.Fatalf("invalid complete source accepted: %v", err)
			}
		})
	}
}

func TestBackgroundParserLimits(t *testing.T) {
	if maxSourceUnits != 500_000 || maxSourceLines != 10_000 || maxNodes != 150_000 || maxDepth != 256 || parseTimeout != 5*time.Second {
		t.Fatal("background parser limits changed")
	}
	for _, language := range []string{"go", "ts"} {
		t.Run(language, func(t *testing.T) {
			source := strings.Repeat(" ", maxSourceUnits-maxSourceLines+1) + strings.Repeat("\n", maxSourceLines-1)
			doc, err := Parse(t.Context(), source, language)
			if err != nil {
				t.Fatalf("exact UTF-16/line boundary: %v", err)
			}
			checkCoverage(t, source, doc)
			for _, over := range []string{source + " ", strings.Repeat("😀", maxSourceUnits/2+1), strings.Repeat("x", 4*maxSourceUnits+1)} {
				if _, err := Parse(t.Context(), over, language); !errors.Is(err, ErrBudget) {
					t.Fatalf("public source budget: %v", err)
				}
			}
			// Stay below source/line/depth limits to exercise the scanner/tree node budget.
			if _, err := parseSyntax(t, strings.Repeat("x;", maxNodes/2+1), language); !errors.Is(err, ErrBudget) {
				t.Fatalf("token/node budget: %v", err)
			}
			if language == "ts" {
				for _, over := range []string{source + " ", strings.Repeat("\r\n", maxSourceLines)} {
					if _, err := parseSyntax(t, over, language); !errors.Is(err, ErrBudget) {
						t.Fatalf("bundle source/line budget: %v", err)
					}
				}
			}
		})
	}
}
