package review

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type Object = map[string]any

type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }
func fail(message string, status ...int) {
	n := 400
	if len(status) > 0 {
		n = status[0]
	}
	panic(&Error{message, n})
}
func capture[T any](fn func() T) (result T, err error) {
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(*Error); ok {
				err = e
			} else {
				panic(p)
			}
		}
	}()
	return fn(), nil
}
func obj(v any, label string) Object {
	if o, ok := v.(map[string]any); ok && o != nil {
		return o
	}
	fail(label + "必须是对象")
	return nil
}
func request(v any) Object {
	if o, ok := v.(map[string]any); ok && o != nil {
		return o
	}
	fail("请求必须是对象")
	return nil
}
func arr(v any, label string) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []Object:
		r := make([]any, len(a))
		for i := range a {
			r[i] = a[i]
		}
		return r
	}
	fail(label + "必须是数组")
	return nil
}
func objects(v any) []Object {
	a := arr(v, "")
	r := make([]Object, len(a))
	for i, x := range a {
		r[i] = obj(x, "")
	}
	return r
}
func str(v any) string { s, _ := v.(string); return s }
func num(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return math.NaN()
}
func present(o Object, k string) bool { _, ok := o[k]; return ok }
func utfLength(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff", r)
	})
}
func text(v any, label string, max int, required bool) string {
	s, ok := v.(string)
	if !ok || utfLength(s) > max || (required && trim(s) == "") {
		nonempty := ""
		if required {
			nonempty = "非空"
		}
		fail(fmt.Sprintf("%s必须是%s文本，最多 %d 字符", label, nonempty, max))
	}
	return s
}
func id(v any, label string) string { return text(v, label, 200, true) }
func choice(v any, label string, choices ...string) string {
	s, ok := v.(string)
	if ok {
		for _, c := range choices {
			if c == s {
				return s
			}
		}
	}
	fail(label + "无效")
	return ""
}
func positive(v any, label string) float64 {
	n := num(v)
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 1 || n > 9007199254740991 {
		fail(label)
	}
	return n
}
func coordinate(v any, label string, pos bool) float64 {
	n := num(v)
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(n) > 1e7 || (pos && (math.Trunc(n) != n || n < 1)) {
		fail(label + "无效")
	}
	return n
}
func date(v any, label string) string {
	s := text(v, label, 100, true)
	if _, ok := dateTime(s); !ok {
		fail(label + "必须是有效日期")
	}
	return s
}
func sessionDate(v any) string {
	s, ok := v.(string)
	_, valid := dateTime(s)
	if !ok || !valid {
		fail("会话日期无效")
	}
	return s
}
func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func newID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
func hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func copyObject(o Object) Object {
	r := Object{}
	for k, v := range o {
		r[k] = v
	}
	return r
}
func clone(v any) any {
	switch o := v.(type) {
	case Object:
		r := Object{}
		for k, v := range o {
			r[k] = clone(v)
		}
		return r
	case []Object:
		r := make([]Object, len(o))
		for i := range o {
			r[i] = clone(o[i]).(Object)
		}
		return r
	case []any:
		r := make([]any, len(o))
		for i := range o {
			r[i] = clone(o[i])
		}
		return r
	}
	return v
}
func listMap(v any, fn func(Object) Object) []any {
	a := objects(v)
	r := make([]any, len(a))
	for i, x := range a {
		r[i] = fn(x)
	}
	return r
}
func filter(v any, fn func(Object) bool) []any {
	r := []any{}
	for _, x := range objects(v) {
		if fn(x) {
			r = append(r, x)
		}
	}
	return r
}
func find(v any, key string, value any) Object {
	for _, x := range objects(v) {
		if equal(x[key], value) {
			return x
		}
	}
	return nil
}
func optionalObjects(v any) []Object {
	if v == nil {
		return nil
	}
	return objects(v)
}
func fields(o Object, keys ...string) []any {
	a := make([]any, len(keys))
	for i, k := range keys {
		a[i] = o[k]
	}
	return a
}
func equal(a, b any) bool { return stringify(a) == stringify(b) }
func lessUTF(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
func jsString(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case []any:
		s := make([]string, len(x))
		for i, v := range x {
			s[i] = jsString(v)
		}
		return strings.Join(s, ",")
	case Object:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}
func jsSort(a []any) []any {
	sort.SliceStable(a, func(i, j int) bool { return lessUTF(jsString(a[i]), jsString(a[j])) })
	return a
}

// ordered is used only where JSON object property order is part of a JS fingerprint.
type property struct {
	key   string
	value any
}
type ordered []property

func stringify(v any) string { var b bytes.Buffer; writeJSON(&b, v); return b.String() }
func writeJSON(b *bytes.Buffer, v any) {
	switch x := v.(type) {
	case ordered:
		b.WriteByte('{')
		for i, p := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, p.key)
			b.WriteByte(':')
			writeJSON(b, p.value)
		}
		b.WriteByte('}')
	case Object:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF(keys[i], keys[j]) })
		o := ordered{}
		for _, k := range keys {
			o = append(o, property{k, x[k]})
		}
		writeJSON(b, o)
	case []Object:
		a := make([]any, len(x))
		for i := range x {
			a[i] = x[i]
		}
		writeJSON(b, a)
	case []any:
		b.WriteByte('[')
		for i, v := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, v)
		}
		b.WriteByte(']')
	case string:
		b.WriteByte('"')
		for _, r := range x {
			switch r {
			case '"', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 32 {
					const digits = "0123456789abcdef"
					b.WriteString(`\u00`)
					b.WriteByte(digits[r/16])
					b.WriteByte(digits[r%16])
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			b.WriteString("null")
		} else if x == 0 {
			b.WriteByte('0')
		} else {
			a := math.Abs(x)
			f := 'f'
			if a < 1e-6 || a >= 1e21 {
				f = 'e'
			}
			s := strconv.FormatFloat(x, byte(f), -1, 64)
			s = strings.ReplaceAll(strings.ReplaceAll(s, "e-0", "e-"), "e+0", "e+")
			b.WriteString(s)
		}
	default:
		d, e := json.Marshal(v)
		if e != nil {
			panic(e)
		}
		b.Write(d)
	}
}
func manifestJSON(files []Object) string {
	a := make([]any, len(files))
	for i, f := range files {
		a[i] = ordered{{"path", f["path"]}, {"sha256", f["sha256"]}}
	}
	return stringify(a)
}
