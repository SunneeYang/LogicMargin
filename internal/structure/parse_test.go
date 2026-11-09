package structure

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"
	"unicode/utf16"
)

func mustParse(t testing.TB, source, language string) Document {
	t.Helper()
	doc, err := Parse(context.Background(), source, language)
	if err != nil {
		t.Fatalf("Parse(%s, %q): %v", language, source, err)
	}
	checkCoverage(t, source, doc)
	return doc
}

func checkCoverage(t testing.TB, source string, doc Document) {
	t.Helper()
	units := utf16.Encode([]rune(source))
	end := 0
	for _, token := range doc.Tokens {
		if token.From < end || token.To < token.From || token.To > len(units) {
			t.Fatalf("unordered/out-of-range token %#v after %d", token, end)
		}
		for _, at := range []int{token.From, token.To} {
			if at > 0 && at < len(units) && units[at-1] >= 0xd800 && units[at-1] <= 0xdbff && units[at] >= 0xdc00 && units[at] <= 0xdfff {
				t.Fatalf("split surrogate at %d", at)
			}
		}
		gap := string(utf16.Decode(units[end:token.From]))
		if strings.IndexFunc(gap, func(r rune) bool { return !unicode.IsSpace(r) && r != '\ufeff' }) >= 0 {
			t.Fatalf("uncovered source %q before %#v", gap, token)
		}
		text := string(utf16.Decode(units[token.From:token.To]))
		if token.To > token.From && token.Key != ";:;" && !strings.HasSuffix(token.Key, ":"+text) {
			t.Fatalf("token lost original spelling %q: %#v", text, token)
		}
		end = token.To
	}
	if gap := string(utf16.Decode(units[end:])); strings.IndexFunc(gap, func(r rune) bool { return !unicode.IsSpace(r) && r != '\ufeff' }) >= 0 {
		t.Fatalf("uncovered tail %q", gap)
	}
	end = 0
	for _, scope := range doc.Scopes {
		if scope.From < end || scope.To <= scope.From || scope.To > len(units) || scope.Shape == "" || scope.Name == "" {
			t.Fatalf("invalid scope %#v after %d", scope, end)
		}
		end = scope.To
	}
	if doc.Shape == "" || doc.ParsedAs == "" {
		t.Fatal("missing parse metadata")
	}
}

func keys(doc Document) []string {
	keys := make([]string, len(doc.Tokens))
	for i, token := range doc.Tokens {
		keys[i] = token.Key
	}
	return keys
}

func TestGoModesAndScopes(t *testing.T) {
	for _, test := range []struct{ mode, source string }{
		{"file", "package 中文\n// 😀\ntype Box[T any] struct{}\nfunc (b *Box[T]) Read(x int) int { return x }\nfunc Same() {}\nfunc Same() {}\n"},
		{"declarations", "func Read(x int) int { return x }\nfunc Same() {}\nfunc Same() {}"},
		{"statements", "x := \"😀中文\"\nif len(x)>0 { println(x) }"},
		{"statements", "return 1"},
	} {
		t.Run(test.mode+test.source[:6], func(t *testing.T) {
			doc := mustParse(t, test.source, "go")
			if doc.ParsedAs != test.mode {
				t.Fatalf("parsedAs %q, want %q", doc.ParsedAs, test.mode)
			}
			if test.mode != "statements" {
				if len(doc.Scopes) != 3 || doc.Scopes[1].Name != "Same" || doc.Scopes[2].Name != "Same" {
					t.Fatalf("duplicate scope names must survive: %#v", doc.Scopes)
				}
				if test.mode == "file" && (doc.Scopes[0].Kind != "method" || doc.Scopes[0].Name != "Box.Read") {
					t.Fatalf("receiver identity: %#v", doc.Scopes[0])
				}
			} else if len(doc.Scopes) != 0 {
				t.Fatalf("virtual wrapper leaked: %#v", doc.Scopes)
			}
		})
	}
}

func TestGoFormattingAndBoundaries(t *testing.T) {
	a := mustParse(t, "package p\nfunc F(x int) int {\nreturn x+1\n}\n", "go")
	b := mustParse(t, "package p; func F( x int ) int { return x + 1; };", "go")
	if !reflect.DeepEqual(keys(a), keys(b)) || a.Shape != b.Shape || a.Scopes[0].Shape != b.Scopes[0].Shape {
		t.Fatalf("formatting changed tokens/shape:\n%v\n%v\n%s %s", keys(a), keys(b), a.Shape, b.Shape)
	}
	for _, token := range a.Tokens {
		if token.Key == ";:;" && !token.Boundary {
			t.Fatal("semicolon missing boundary")
		}
	}
	for _, source := range []string{
		"package p\nvar x=1 /* first\nsecond */\n",
		"package p\n// 中文😀\r\nvar x=`raw\r\n  😀`\n",
		"\ufeffpackage p\nvar x = 0x1f //comment\r\n",
	} {
		mustParse(t, source, "go")
	}
	base := mustParse(t, "return x", "go")
	changed := mustParse(t, "return\nx", "go")
	if reflect.DeepEqual(keys(base), keys(changed)) {
		t.Fatal("Go restricted newline disappeared")
	}
}

func TestJavaScriptSyntaxAndScopes(t *testing.T) {
	for _, test := range []struct{ language, source string }{
		{"js", "export async function F(x) { function nested() {} return /a[ b]+/giu.test(x) }\nclass A { static *m(x) { yield x } get value() {return 1} }\nfunction F() {}"},
		{"mjs", "import x from './x.mjs'; export function f(){return x}"},
		{"cjs", "const x=require('x'); module.exports=function named(){return x}"},
		{"ts", "interface Box<T> {value: T}\nexport function take<T extends string>(x: Box<T>): T { return x.value! }\nclass A<T> { read(x:T):T {return x} }"},
		{"ts", "type Route = `prefix-${string}-${number}`; const tag = `a${`b${x}c`}d`;"},
		{"jsx", "function View(){return <div title=\"😀\">  中文 <span> </span>{x}</div>}"},
		{"tsx", "type Props = {name: string}; export function View({name}: Props): JSX.Element {return <div>  😀中文 {name} </div>}"},
	} {
		t.Run(test.language, func(t *testing.T) {
			doc := mustParse(t, test.source, test.language)
			if test.language == "js" {
				if len(doc.Scopes) != 4 || doc.Scopes[0].Name != "F" || doc.Scopes[1].Name != "A.m" || doc.Scopes[2].Name != "A.value" || doc.Scopes[3].Name != "F" {
					t.Fatalf("outer named functions/methods: %#v", doc.Scopes)
				}
			}
		})
	}
}

func TestJavaScriptFormattingAndContent(t *testing.T) {
	if a, b := mustParse(t, "", "js"), mustParse(t, "  \n\t\r\n", "js"); len(a.Tokens) != 0 || len(b.Tokens) != 0 || a.Shape != b.Shape {
		t.Fatal("whitespace-only scripts must normalize")
	}
	var packed, spaced strings.Builder
	for i := range 8 {
		fmt.Fprintf(&packed, "const x%d=%d;\n", i, i)
		fmt.Fprintf(&spaced, "const%sx%d = %d ;\n\n", strings.Repeat(" ", 150), i, i)
	}
	if a, b := mustParse(t, "function packed(){"+packed.String()+"}", "js"), mustParse(t, "function packed(){\n"+spaced.String()+"}", "js"); a.Shape != b.Shape || a.Scopes[0].Shape != b.Scopes[0].Shape || !reflect.DeepEqual(keys(a), keys(b)) {
		t.Fatal("Lezer tree packing must not change syntax shape")
	}
	a := mustParse(t, "function f(x: number):number {return x>1?x:0;}", "ts")
	b := mustParse(t, "function f( x : number ) : number {\n  return x > 1 ? x : 0;\n}", "ts")
	if !reflect.DeepEqual(keys(a), keys(b)) || a.Shape != b.Shape || a.Scopes[0].Shape != b.Scopes[0].Shape {
		t.Fatal("safe formatting changed token stream or shape")
	}
	c := mustParse(t, "function f(x: number):number {return x>=1?x:0;}", "ts")
	if reflect.DeepEqual(keys(a), keys(c)) {
		t.Fatal("small condition change disappeared")
	}
	for _, test := range []struct{ language, before, after string }{
		{"js", "const x='a b'", "const x='a  b'"},
		{"js", "// a b\nlet x=1", "// a  b\nlet x=1"},
		{"js", "/* a b */let x=1", "/* a  b */let x=1"},
		{"js", "const x=/a b/", "const x=/a  b/"},
		{"js", "const x=` a ${value} b `", "const x=` a  ${value} b `"},
		{"js", "const x=` `", "const x=`  `"},
		{"tsx", "const x=<div> </div>", "const x=<div>  </div>"},
		{"tsx", "const x=<div> a {x} </div>", "const x=<div>  a {x} </div>"},
		{"ts", "const x: string='x'", "const x: unknown='x'"},
		{"js", "const x=1_000", "const x=1000"},
	} {
		a := mustParse(t, test.before, test.language)
		b := mustParse(t, test.after, test.language)
		if reflect.DeepEqual(keys(a), keys(b)) {
			t.Errorf("content ignored: %q / %q", test.before, test.after)
		}
	}
}

func TestJavaScriptScopesRequireFileDeclarations(t *testing.T) {
	before := "if (enabled) { function f(){return 1;} use(f); } else {}"
	after := "if (enabled) { use(f); } else { function f(){return 1;} }"
	for _, source := range []string{
		before, after,
		"if (enabled) { class A { m(){} } } else { class A { m(){} } }",
		"{ function f(){} }",
		"const f = function named(){}; const A = class Named {m(){}};",
	} {
		if doc := mustParse(t, source, "js"); len(doc.Scopes) != 0 {
			t.Fatalf("non-file declaration exposed as move scope: %#v", doc.Scopes)
		}
	}
	a, b := mustParse(t, before, "js"), mustParse(t, after, "js")
	if reflect.DeepEqual(keys(a), keys(b)) || a.Shape == b.Shape {
		t.Fatal("cross-branch binding change disappeared")
	}
	doc := mustParse(t, "export function f(){} export class A {m(){}}", "js")
	if len(doc.Scopes) != 2 || doc.Scopes[0].Name != "f" || doc.Scopes[1].Name != "A.m" {
		t.Fatalf("file export declarations missing: %#v", doc.Scopes)
	}
	for _, source := range []string{
		"declare function f(): void; export declare function g(): void; declare class A {m():void}",
		"namespace N { export function f(){} }",
		"@decorator class A {m(){}} class B {@decorator m(){}}",
		"class A {[name](){}}",
	} {
		if doc := mustParse(t, source, "ts"); len(doc.Scopes) != 0 {
			t.Fatalf("wrapped/decorated/computed declaration exposed: %#v", doc.Scopes)
		}
	}
}

func TestJavaScriptExportScopeIncludesWrapper(t *testing.T) {
	before := "export function a(){return 1;} function b(){return 2;}"
	after := "function a(){return 1;} export function b(){return 2;}"
	a, b := mustParse(t, before, "js"), mustParse(t, after, "js")
	if len(a.Scopes) != 2 || len(b.Scopes) != 2 {
		t.Fatal("file functions missing")
	}
	for i := range a.Scopes {
		if a.Scopes[i].Name != b.Scopes[i].Name || a.Scopes[i].Shape == b.Scopes[i].Shape {
			t.Fatalf("export reassociation lost scope structure: %#v / %#v", a.Scopes[i], b.Scopes[i])
		}
	}
	if a.Scopes[0].From != 0 || before[a.Scopes[0].From:a.Scopes[0].To] != "export function a(){return 1;}" {
		t.Fatalf("export prefix outside scope: %#v", a.Scopes[0])
	}
	for _, source := range []string{"export default async function f(){return 1;}", "export function f<T>(x:T):T{return x}"} {
		doc := mustParse(t, source, "ts")
		if len(doc.Scopes) != 1 || doc.Scopes[0].From != 0 || doc.Scopes[0].To != len(source) {
			t.Fatalf("full export scope missing: %#v", doc.Scopes)
		}
	}
}

func TestJavaScriptASIBoundaries(t *testing.T) {
	for _, source := range []string{
		"function f(){return\nvalue}",
		"function f(){break\nlabel}",
		"function f(){continue\nlabel}",
		"function* f(){yield\nvalue}",
		"async\nfunction f(){}",
		"let x=1,y=2; x\n++y",
		"let x=1,y=2; x++\ny",
		"function f(){return /*comment\n*/ value}",
	} {
		doc := mustParse(t, source, "js")
		boundary := false
		for _, token := range doc.Tokens {
			boundary = boundary || token.Boundary
		}
		if !boundary {
			t.Errorf("missing ASI boundary: %q", source)
		}
	}
	a := mustParse(t, "function f(){return value}", "js")
	b := mustParse(t, "function f(){return\nvalue}", "js")
	if a.Shape == b.Shape || a.Scopes[0].Shape == b.Scopes[0].Shape {
		t.Fatal("ASI changed syntax but not tree/scope shape")
	}
	mustParse(t, "const object = {throw\n: 1, return\n: 2}", "js")
}

func TestUTF16Coordinates(t *testing.T) {
	for _, test := range []struct{ language, source string }{
		{"go", "// 😀中文\nfunc F() string {return \"😀中文\"}"},
		{"ts", "// 😀中文\nfunction F(): string {return '😀中文'}"},
		{"tsx", "// 😀\nfunction F(){return <div>😀中文</div>}"},
	} {
		doc := mustParse(t, test.source, test.language)
		if doc.Scopes[0].From != len(utf16.Encode([]rune(test.source[:strings.Index(test.source, "func")]))) {
			t.Fatalf("wrong UTF16 scope start: %#v", doc.Scopes)
		}
	}
}

func TestErrorsAndBudgets(t *testing.T) {
	for _, test := range []struct{ language, source string }{
		{"go", "func f( {"}, {"go", "if true {"}, {"go", "package p\nfunc f(){"},
		{"js", "function f( {"}, {"ts", "const x: = 1"}, {"tsx", "const x = <div>"},
		{"js", "const x: number=1"}, {"js", "let x = `unterminated"},
		{"js", "const x=a!"}, {"js", "function f(){throw\nx}"},
		{"js", "const f = x\n=>x"}, {"js", "const f = async\n(x)=>x"}, {"js", "function* f(){yield\n* x}"},
	} {
		if _, err := Parse(context.Background(), test.source, test.language); !errors.Is(err, ErrSyntax) {
			t.Errorf("Parse(%s,%q) = %v, want ErrSyntax", test.language, test.source, err)
		}
	}
	if _, err := Parse(context.Background(), "x", "python"); !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
	for _, language := range []string{"go", "js"} {
		for _, source := range []string{strings.Repeat("x", maxSourceUnits+1), strings.Repeat("\n", maxSourceLines), "var x=" + strings.Repeat("(", maxDepth+1) + "1" + strings.Repeat(")", maxDepth+1)} {
			if _, err := Parse(context.Background(), source, language); !errors.Is(err, ErrBudget) {
				t.Errorf("%s over budget = %v", language, err)
			}
		}
	}
	for _, newline := range []string{"\r", "\r\n", "\u2028", "\u2029"} {
		if _, err := Parse(context.Background(), strings.Repeat(newline, maxSourceLines), "js"); !errors.Is(err, ErrBudget) {
			t.Errorf("JS line budget %q: %v", newline, err)
		}
	}
	for _, language := range []string{"go", "js"} {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := Parse(ctx, "", language); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	}
}

func TestJavaScriptInterruptAndIsolation(t *testing.T) {
	// Compile before timing: the shared program is immutable, while every parse owns a VM.
	if _, err := javascriptProgram(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(5*time.Millisecond, cancel)
	defer timer.Stop()
	start := time.Now()
	_, err := Parse(ctx, benchmarkSource("js", true), "js")
	if !errors.Is(err, context.Canceled) || time.Since(start) > time.Second {
		t.Fatalf("in-flight cancellation: %v, elapsed %s", err, time.Since(start))
	}
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() { mustParse(t, "function F(){return `😀 ${x}`}", "js") })
	}
	wg.Wait()
}

func benchmarkSource(language string, dense bool) string {
	if !dense {
		if language == "go" {
			return "package p\nvar text = `" + strings.Repeat("x", 99_976) + "`\n"
		}
		return "const text = `" + strings.Repeat("x", 99_984) + "`;"
	}
	var b strings.Builder
	if language == "go" {
		b.WriteString("package p\n")
	}
	for i := 0; ; i++ {
		line := fmt.Sprintf("function F%d(x){if(x>1){return x+1;}return x;}\n", i)
		if language == "go" {
			line = fmt.Sprintf("func F%d(x int) int {if x>1 {return x+1};return x}\n", i)
		}
		if b.Len()+len(line) > maxSourceUnits || i >= 1_990 {
			break
		}
		b.WriteString(line)
	}
	b.WriteString(strings.Repeat(" ", maxSourceUnits-b.Len()))
	return b.String()
}

func TestBudgetMeasurements(t *testing.T) {
	for _, language := range []string{"go", "js"} {
		for _, dense := range []bool{false, true} {
			source := benchmarkSource(language, dense)
			start := time.Now()
			doc, err := Parse(context.Background(), source, language)
			elapsed := time.Since(start)
			t.Logf("%s dense=%t UTF16=%d elapsed=%s tokens=%d scopes=%d error=%v", language, dense, len(utf16.Encode([]rune(source))), elapsed, len(doc.Tokens), len(doc.Scopes), err)
			if err != nil && !errors.Is(err, ErrBudget) {
				t.Fatal(err)
			}
			if err == nil {
				checkCoverage(t, source, doc)
			}
		}
	}
}

func BenchmarkParse100K(b *testing.B) {
	for _, language := range []string{"go", "js"} {
		for _, dense := range []bool{false, true} {
			b.Run(fmt.Sprintf("%s/dense=%t", language, dense), func(b *testing.B) {
				source := benchmarkSource(language, dense)
				b.ReportAllocs()
				b.SetBytes(int64(len(source)))
				for b.Loop() {
					if _, err := Parse(context.Background(), source, language); err != nil && !errors.Is(err, ErrBudget) {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
