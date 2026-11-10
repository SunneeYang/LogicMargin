These fixtures use the TypeScript compatibility oracle introduced with
LogicMargin 0.8.7. The mock repository label has been neutralized and the
fixtures regenerated from the current generator; they are not unchanged Git snapshots.

Regenerate from the repository root with Node >=22.18:

```
node internal/review/testdata/generate-oracle.mjs
```

`oracle.json` contains parser results and exact domain errors, normalized
source manifests and SHA-256, byte-for-byte logic identities, rebase/current
projections, and a create/comment/submit/ack/revise/approve/archive/restore/delete
sequence. The Go tests read these fixed results without Node. Only the generated
session ID, session timestamps, submission timestamps and snapshot opening times
are normalized by lifecycle comparisons; authored dates, source hashes, IDs,
rounds, versions and other fields are compared exactly.

`legacy-session.json.gz` is an actual gzip archive written by the original
TypeScript store. It is read, restored and archived again by the Go tests.

The generator and fixtures are development tools, never runtime dependencies.

Remaining boundaries: the legacy free-text forms accepted by V8 `Date.parse`
are not exhaustive here; normal persisted ISO timestamps and the listed legacy
forms have fixed coverage. HTTP, CLI and persisted JSON reject isolated UTF-16
surrogates before Go's decoder can replace them. Malformed legacy files remain
unchanged and cannot be mutated; repair the original file before retrying.
Platforms whose `os.FileInfo` omits change-time disable
session caching and conservatively re-read the file.

`agent-tmp-run` is an optional developer-machine temp harness, not a public dependency. Honor local AGENTS requirements when present; the generator also works with the platform temporary directory.
