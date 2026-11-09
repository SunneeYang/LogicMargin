package structure

import (
	"context"
	"crypto/sha256"
	"embed"
	"fmt"
	"runtime"
	"time"
	"unicode/utf8"
)

const (
	maxSourceUnits = 100_000
	maxSourceLines = 2_000
	maxNodes       = 50_000
	maxDepth       = 256
	parseTimeout   = 750 * time.Millisecond
)

//go:embed parse.go go.go javascript.go types.go
var nativeSources embed.FS

var algorithm = func() string {
	h := sha256.New()
	h.Write([]byte(runtime.Version() + "\x00"))
	h.Write([]byte(javascriptBundle))
	for _, path := range []string{"parse.go", "go.go", "javascript.go", "types.go"} {
		data, _ := nativeSources.ReadFile(path)
		h.Write([]byte(path + "\x00"))
		h.Write(data)
	}
	return fmt.Sprintf("structure-v1-%x", h.Sum(nil))
}()

func Algorithm() string { return algorithm }

// Parse describes saved source syntax, without type checking or semantic equivalence claims.
func Parse(ctx context.Context, source, language string) (Document, error) {
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	switch language {
	case "go", "js", "mjs", "cjs", "jsx", "ts", "tsx":
	default:
		return Document{}, ErrUnsupported
	}
	if !utf8.ValidString(source) {
		return Document{}, ErrSyntax
	}
	if len(source) > 4*maxSourceUnits {
		return Document{}, ErrBudget
	}
	units := 0
	lines := 1
	for i, r := range source {
		units++
		if r > 0xffff {
			units++
		}
		if r == '\n' || language != "go" && (r == '\u2028' || r == '\u2029' || r == '\r' && (i+1 == len(source) || source[i+1] != '\n')) {
			lines++
		}
	}
	if units > maxSourceUnits || lines > maxSourceLines {
		return Document{}, ErrBudget
	}
	budget, cancel := context.WithTimeout(ctx, parseTimeout)
	defer cancel()
	var result Document
	var err error
	if language == "go" {
		result, err = parseGo(budget, source)
	} else {
		result, err = parseJavaScript(budget, source, language)
	}
	if ctx.Err() != nil {
		return Document{}, ctx.Err()
	}
	if budget.Err() != nil {
		return Document{}, ErrBudget
	}
	if err != nil {
		return Document{}, err
	}
	return result, nil
}
