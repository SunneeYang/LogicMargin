package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
	"unicode/utf16"

	"logicmargin/internal/review"
)

type object = review.Object

func obj(v any) object { o, _ := v.(map[string]any); return o }
func arr(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []object:
		result := make([]any, len(a))
		for i, item := range a {
			result[i] = item
		}
		return result
	default:
		return nil
	}
}
func str(v any) string     { s, _ := v.(string); return s }
func number(v any) float64 { n, _ := v.(float64); return n }
func safeInteger(v any) bool {
	n, ok := v.(float64)
	return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && math.Abs(n) <= 9007199254740991
}
func copyObject(o object) object {
	c := object{}
	for k, v := range o {
		c[k] = v
	}
	return c
}
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func trim(s string) string {
	// ECMAScript trim includes BOM but excludes Go's NEL whitespace.
	return strings.TrimFunc(s, func(r rune) bool {
		return r == '\ufeff' || r == '\u0009' || r == '\u000a' || r == '\u000b' || r == '\u000c' || r == '\u000d' || r == '\u0020' || r == '\u00a0' || r == '\u1680' || r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' || r == '\u202f' || r == '\u205f' || r == '\u3000'
	})
}
func jsonBytes(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'}), nil
}
func writeJSON(w io.Writer, v any) error {
	e := json.NewEncoder(w)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	return e.Encode(v)
}
func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func validDate(v any) bool {
	s, ok := v.(string)
	if !ok || trim(s) == "" || utf16Len(s) > 100 {
		return false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02", time.RFC1123, time.RFC1123Z, "2006-01-02T15:04:05.999999999-0700"} {
		if _, err := time.Parse(layout, s); err == nil {
			return true
		}
	}
	return false
}
func checkedBaseline(v any, id string) (object, error) {
	b, err := review.ParseBaseline(v)
	if err != nil {
		return nil, err
	}
	if id != "" && b["id"] != id {
		return nil, fmt.Errorf("固定基线必须属于相同评审 ID")
	}
	return b, nil
}
