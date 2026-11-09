package structure

import (
	"context"
	"crypto/sha256"
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

func parseGo(ctx context.Context, source string) (Document, error) {
	// Scanner offsets are bytes; this table also maps zero-width inserted semicolons.
	offsets := make([]int, len(source)+1)
	units := 0
	nextCheck := 0
	for i, r := range source {
		if i >= nextCheck {
			if err := ctx.Err(); err != nil {
				return Document{}, err
			}
			nextCheck = i + 4096
		}
		for j := 0; j < utf8.RuneLen(r); j++ {
			offsets[i+j] = units
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	offsets[len(source)] = units
	tokens, err := scanGo(ctx, source, offsets)
	if err != nil {
		return Document{}, err
	}
	result := Document{Tokens: tokens, Scopes: []Scope{}}
	for _, mode := range []string{"file", "declarations", "statements"} {
		if err := ctx.Err(); err != nil {
			return Document{}, err
		}
		prefix, suffix := "", ""
		switch mode {
		case "declarations":
			prefix = "package structurefragment\n"
		case "statements":
			prefix, suffix = "package structurefragment\nfunc __fragment__(){\n", "\n}"
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, "saved.go", prefix+source+suffix, parser.ParseComments|parser.SkipObjectResolution)
		if err := ctx.Err(); err != nil {
			return Document{}, err
		}
		if err != nil {
			continue
		}
		var root any = file
		if mode == "declarations" {
			root = file.Decls
		} else if mode == "statements" {
			root = file.Decls[0].(*ast.FuncDecl).Body.List
		}
		result.Shape, err = goShape(ctx, root)
		if err != nil {
			return Document{}, err
		}
		result.ParsedAs = mode
		if mode != "statements" {
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				from, to := fset.PositionFor(fn.Pos(), false).Offset-len(prefix), fset.PositionFor(fn.End(), false).Offset-len(prefix)
				if from < 0 || to > len(source) || to < from {
					return Document{}, ErrSyntax
				}
				kind, name := "function", fn.Name.Name
				if fn.Recv != nil {
					kind = "method"
					if len(fn.Recv.List) != 1 {
						continue
					}
					receiver := receiverName(fn.Recv.List[0].Type)
					if receiver == "" {
						continue
					}
					name = receiver + "." + name
				}
				shape, err := goShape(ctx, fn)
				if err != nil {
					return Document{}, err
				}
				result.Scopes = append(result.Scopes, Scope{Kind: kind, Name: name, From: offsets[from], To: offsets[to], Shape: shape})
			}
		}
		return result, nil
	}
	return Document{}, ErrSyntax
}

func scanGo(ctx context.Context, source string, offsets []int) ([]Token, error) {
	file := token.NewFileSet().AddFile("saved.go", -1, len(source))
	var scan scanner.Scanner
	invalid := false
	scan.Init(file, []byte(source), func(token.Position, string) { invalid = true }, scanner.ScanComments)
	tokens := []Token{}
	end, depth := 0, 0
	if strings.HasPrefix(source, "\ufeff") {
		tokens = append(tokens, Token{From: 0, To: 1, Key: "BOM:\ufeff"})
		end = len("\ufeff")
	}
	for {
		if len(tokens)%128 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		pos, kind, literal := scan.Scan()
		if invalid {
			return nil, ErrSyntax
		}
		if kind == token.EOF {
			break
		}
		if len(tokens) >= maxNodes {
			return nil, ErrBudget
		}
		from := file.Offset(pos)
		to := from + len(literal)
		if literal == "" {
			to = from + len(kind.String())
		}
		if kind == token.SEMICOLON && literal == "\n" {
			// An inserted semicolon can lie inside an already emitted multiline comment.
			from = max(from, end)
			to = from
		} else if kind == token.COMMENT || kind == token.STRING && strings.HasPrefix(literal, "`") {
			// scanner strips CR from raw literals and comments; keys retain the saved bytes.
			switch {
			case strings.HasPrefix(source[from:], "//"):
				to = len(source)
				if n := strings.IndexByte(source[from:], '\n'); n >= 0 {
					to = from + n
				}
			case strings.HasPrefix(source[from:], "/*"):
				to = from + 2 + strings.Index(source[from+2:], "*/") + 2
			default:
				to = from + 1 + strings.IndexByte(source[from+1:], '`') + 1
			}
		}
		if from < end || to < from || to > len(source) || !goWhitespace(source[end:from]) {
			return nil, ErrSyntax
		}
		key := kind.String() + ":" + source[from:to]
		if kind == token.SEMICOLON {
			key = ";:;"
		}
		tokens = append(tokens, Token{From: offsets[from], To: offsets[to], Key: key, Boundary: kind == token.SEMICOLON})
		end = to
		switch kind {
		case token.LPAREN, token.LBRACE, token.LBRACK:
			depth++
			if depth > maxDepth {
				return nil, ErrBudget
			}
		case token.RPAREN, token.RBRACE, token.RBRACK:
			depth--
		}
	}
	if !goWhitespace(source[end:]) {
		return nil, ErrSyntax
	}
	return tokens, nil
}

func goWhitespace(s string) bool { return strings.Trim(s, " \t\r\n") == "" }

func receiverName(expr ast.Expr) string {
	switch expr := expr.(type) {
	case *ast.Ident:
		return expr.Name
	case *ast.StarExpr:
		return receiverName(expr.X)
	case *ast.IndexExpr:
		return receiverName(expr.X)
	case *ast.IndexListExpr:
		return receiverName(expr.X)
	}
	return ""
}

var positionType = reflect.TypeFor[token.Pos]()
var nodeType = reflect.TypeFor[ast.Node]()

// Reflection includes syntax fields and values but excludes every token.Pos and resolver back-link.
func goShape(ctx context.Context, root any) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	hash := sha256.New()
	nodes := 0
	var walk func(reflect.Value, int) error
	walk = func(v reflect.Value, depth int) error {
		if !v.IsValid() || v.Type() == positionType {
			return nil
		}
		if v.Kind() == reflect.Pointer && !v.IsNil() && v.Type().Implements(nodeType) {
			nodes++
			depth++
			if depth > maxDepth || nodes > maxNodes {
				return ErrBudget
			}
			if nodes%128 == 0 {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
		}
		io.WriteString(hash, "("+v.Type().String()+":")
		switch v.Kind() {
		case reflect.Interface, reflect.Pointer:
			if !v.IsNil() {
				if err := walk(v.Elem(), depth); err != nil {
					return err
				}
			}
		case reflect.Struct:
			for i := 0; i < v.NumField(); i++ {
				field := v.Type().Field(i)
				if field.Type == positionType || field.Name == "Obj" || field.Name == "Scope" || field.Name == "Unresolved" {
					continue
				}
				io.WriteString(hash, field.Name)
				if err := walk(v.Field(i), depth); err != nil {
					return err
				}
			}
		case reflect.Slice:
			for i := 0; i < v.Len(); i++ {
				if err := walk(v.Index(i), depth); err != nil {
					return err
				}
			}
		default:
			fmt.Fprintf(hash, "%#v", v.Interface())
		}
		io.WriteString(hash, ")")
		return nil
	}
	if err := walk(reflect.ValueOf(root), 0); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}
