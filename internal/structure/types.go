package structure

import (
	"errors"
)

var ErrUnsupported = errors.New("unsupported-language")
var ErrSyntax = errors.New("invalid-syntax")
var ErrBudget = errors.New("budget")

// Offsets are UTF-16 units into the exact saved source, never virtual wrapper text.
type Token struct {
	From     int    `json:"from"`
	To       int    `json:"to"`
	Key      string `json:"key"`
	Boundary bool   `json:"boundary,omitempty"`
}
type Scope struct {
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Shape string `json:"shape"`
}
type Document struct {
	Tokens   []Token `json:"tokens"`
	Scopes   []Scope `json:"scopes"`
	Shape    string  `json:"shape"`
	ParsedAs string  `json:"parsedAs"`
}

// Parse is implemented by the language adapters; caller owns caching and matching.
// Implement: func Parse(ctx context.Context, source, language string) (Document,error)
