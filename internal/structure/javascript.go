package structure

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/dop251/goja"
)

//go:embed parser.bundle.js
var javascriptBundle string

var javascriptProgram = sync.OnceValues(func() (*goja.Program, error) {
	return goja.Compile("parser.bundle.js", javascriptBundle, true)
})

func parseJavaScript(ctx context.Context, source, language string) (Document, error) {
	program, err := javascriptProgram()
	if err != nil {
		return Document{}, fmt.Errorf("compile structure parser: %w", err)
	}
	vm := goja.New()
	finished := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		vm.Interrupt(ctx.Err())
		close(finished)
	})
	defer func() {
		if !stop() {
			<-finished
		}
	}()
	if _, err := vm.RunProgram(program); err != nil {
		return Document{}, javascriptError(ctx, err)
	}
	parse, ok := goja.AssertFunction(vm.Get("LogicMarginStructure").ToObject(vm).Get("parseJSON"))
	if !ok {
		return Document{}, errors.New("structure bundle has no parseJSON function")
	}
	value, err := parse(goja.Undefined(), vm.ToValue(source), vm.ToValue(language))
	if err != nil {
		return Document{}, javascriptError(ctx, err)
	}
	if err := ctx.Err(); err != nil {
		return Document{}, err
	}
	var result struct {
		Document
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(value.String()), &result); err != nil {
		return Document{}, fmt.Errorf("decode structure parser: %w", err)
	}
	switch result.Error {
	case "invalid-syntax":
		return Document{}, ErrSyntax
	case "budget":
		return Document{}, ErrBudget
	case "":
	default:
		return Document{}, fmt.Errorf("structure parser: %s", result.Error)
	}
	result.Shape = fmt.Sprintf("%x", sha256.Sum256([]byte(result.Shape)))
	for i := range result.Scopes {
		result.Scopes[i].Shape = fmt.Sprintf("%x", sha256.Sum256([]byte(result.Scopes[i].Shape)))
	}
	return result.Document, nil
}

func javascriptError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("parse structure: %w", err)
}
