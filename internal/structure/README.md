# Structure parser adapter

`Parse(ctx, source, language)` implements the saved-source parser contract from
`docs/structural-diff.md`. `Algorithm()` binds the bundle, embedded native adapter
sources, grammar versions, pinned Goja version, and actual Go runtime version.
There is no matching, cache, HTTP API, or UI implementation in this package.
Callers may parse a complete, revision-verified source file for background
analysis and project the resulting coordinates onto their displayed slice.
Source verification and projection belong to the caller; this package never
reads a workspace to supplement its input.

## Runtime and build

- Go standard `go/scanner`, `go/parser`, and `go/ast` for `go`.
- `@lezer/javascript` 1.5.6, `@lezer/lr` 1.4.12, `@lezer/common` 1.5.5,
  `@lezer/highlight` 1.2.5 for `js`, `mjs`, `cjs`, `jsx`, `ts`, and `tsx`.
- Goja `v0.0.0-20261108153707-d8dfb4d8b999`, with one immutable compiled
  program and a separate VM per parse. No Node, DOM, or CGo runtime is needed.
- Rebuild with `node scripts/build-structure-parser.mjs`; verify with the same
  command followed by `--check`. The build uses the repository's installed Vite
  and Lezer dependencies and emits one self-contained IIFE.

Builds and tests should run through `/Users/hcm-b0677/.codex/bin/agent-tmp-run`.
For example:

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOTOOLCHAIN=go1.26.0 GOWORK=off go test ./internal/structure -count=1
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOTOOLCHAIN=go1.26.0 GOWORK=off go test -race ./internal/structure -count=1
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOTOOLCHAIN=go1.26.0 GOWORK=off go vet ./internal/structure
/Users/hcm-b0677/.codex/bin/agent-tmp-run node scripts/build-structure-parser.mjs --check
```

## Safety boundaries

Offsets are UTF-16 units into the exact saved source. Tokens are ordered and
non-overlapping; only grammar-safe whitespace outside tokens is omitted. Keys
retain token kinds and complete source spelling, including comments, CR inside
Go raw literals/comments, regular expressions, templates, JSX text, and types.
Go inserted and explicit semicolons share `;:;` and `Boundary=true`; inserted
semicolons overlapping a comment use a zero-length range after that comment.

Go tries a complete file, a virtual package for declarations, and a virtual
package/function for statements. `ParsedAs` distinguishes these modes. Wrapper
coordinates never escape, and synthetic wrapper scopes are omitted. Go shape
hashes omit `token.Pos` and resolver links; `SkipObjectResolution` prevents
object cycles. The native parser itself is bounded by source/token/nesting
limits and checks cancellation between scanner/AST work; it has no interrupt API.

Lezer traversal explicitly uses `IterMode.IncludeAnonymous`. Every error node
fails parsing. Anonymous punctuation leaves are kept. Template raw segments
omitted by the grammar are restored, and leaf coverage is checked against the
source. Shape hashes retain syntax node structure while excluding anonymous
repetition containers whose packing changes with source length. Comments and
all-whitespace JSX/template contents remain tokens. Restricted-production and
increment/decrement newlines produce conservative zero-length boundary tokens;
invalid throw, arrow, and delegated-yield line breaks are rejected explicitly.

The `Parse` limits are 500,000 UTF-16 units, 10,000 lines, 150,000 tokens and
syntax nodes, depth 256, and five seconds per call (each side is a separate
call). These background-analysis limits do not change ordinary text diff or
frontend saved-slice limits. Source validation is included in the deadline,
with a byte-length guard before UTF-8 validation and periodic cancellation
checks during UTF-16 counting and native offset mapping. Go checks cancellation
around its non-interruptible standard-library parser and during scanner/AST
work. A VM timeout or cancellation uses
`Interrupt`; the `AfterFunc` callback is stopped or joined before returning.
Budget exhaustion returns `ErrBudget`; a caller's cancellation/deadline returns
its context error. Unsupported languages return `ErrUnsupported`; scanner,
grammar-recovery, coverage, or supported syntax validation failures return
`ErrSyntax`.

Scopes cover outer named Go functions/methods and JS file-level function
declarations or methods in file-level named class declarations. Exported function
scopes include the entire direct-root `ExportDeclaration` range and shape, so
export/default/async modifiers cannot be detached from their function. Ambient,
decorated, and computed declarations are excluded. Block-local/control-flow
declarations and named expressions have no
scope context in the contract and are deliberately excluded. Go methods use
`Receiver.Method`, JS class methods use `Class.method`. Duplicate identities are
preserved for the caller to handle conservatively. Nested functions, arrows,
object methods, computed methods, and methods in anonymous classes are not move
scopes. Token comparison still covers their entire source. This is syntax
structure, without type checking, contextual early-error checking, or a claim of
general semantic equivalence.

## Validation and measurements

Contract tests cover Go files/declarations/statements/truncation, all supported
JS dialects, real TS/TSX types, safe formatting, condition edits, content-bearing
whitespace, ASI boundaries, tree-packing invariance, duplicate scope names,
UTF-16 emoji/Chinese coordinates, coverage, budgets, cancellation, and concurrent
isolated VMs. Non-race runtime tests require complete Go/TS/TSX files larger than
100,000 UTF-16 units and 2,000 lines to parse under the production deadline,
retain content/ASI distinctions, and reject real syntax errors. Boundary tests
cover exactly 500,000 units/10,000 lines, over-limit surrogate pairs, independent
token/node exhaustion, and the bundle's own source guards. Native cancellation
checks cover offset mapping, scanning, and AST work; VM cancellation remains
interruptible. The cross-compile check builds test executables with
`CGO_ENABLED=0 GOOS=windows GOARCH=amd64` and `GOARCH=arm64`; it does not run them
on Windows. Service integration remains the caller's responsibility.

The following historical measurements used the former 750ms deadline; they have
not been rerun for the larger background budget. Measured on Apple M4 Pro,
darwin/arm64, Go 1.26.0, using synthetic public test
inputs of exactly 100,000 UTF-16 units. The dense Go case has 1,907 functions,
43,864 tokens, and fewer than 2,000 lines. The dense JS case fills the same source
limit with short functions. These are parser microbenchmarks, not HTTP latency
or overall diff speedups.

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOTOOLCHAIN=go1.26.0 GOWORK=off go test ./internal/structure -run '^$' -bench BenchmarkParse100K -benchtime=3x -count=1
```

| Input | Mean per call | Allocated per call | Result |
| --- | ---: | ---: | --- |
| Go long raw literal | 1.19ms | 1.56MB | Parsed |
| Go dense functions | 43.35ms | 28.83MB | Parsed |
| JS long template literal | 260.12ms | 26.28MB | Parsed |
| JS dense functions | 751.95ms | 114.27MB | `ErrBudget` |

The historical dense JS result measures work until interruption, not a completed
parse under the current five-second deadline. The benchmark fixtures remain
exactly 100,000 units regardless of the background parser's source limit.
Syntax correctness tests use adapter calls with a separate test deadline;
non-race tests also require public `Parse` success under the production budget.
Cancellation and resource-limit tests still exercise public `Parse` under race.
Large-input measurements permit a budget fallback. The tree-packing
regression fixture uses eight statements and long safe whitespace to exercise
the boundary without requiring a large parse under race instrumentation.
