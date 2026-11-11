These fixtures use the TypeScript compatibility oracle introduced with
LogicMargin 0.8.7. The mock repository label has been neutralized and the
fixtures regenerated from the current generator; they are not unchanged Git snapshots.

The fixtures are frozen at repository commit
`13e5150631dcfcedec9182b1de221815a8257d71`. The historical
[generator](https://github.com/SunneeYang/LogicMargin/blob/13e5150631dcfcedec9182b1de221815a8257d71/internal/review/testdata/generate-oracle.mjs)
and Node implementation are no longer part of the active backend. Do not regenerate
expected results from the Go implementation being tested.

SHA-256:

- `oracle.json`: `c2f292c3e0e5345ad92752f7081a3f0f4222a167d7f9b8624aecaedf010f2282`
- `legacy-session.json.gz`: `bdfc9e4ff33e8796599916bd3e13ec43d1e0c4658f97b7d297c473e2a077ad29`

`oracle.json` contains parser results and exact domain errors, normalized
source manifests and SHA-256, byte-for-byte logic identities, rebase/current
projections, and a create/comment/submit/ack/revise/approve/archive/restore/delete
sequence. The Go tests read these fixed results without Node. Only the generated
session ID, session timestamps, submission timestamps and snapshot opening times
are normalized by lifecycle comparisons; authored dates, source hashes, IDs,
rounds, versions and other fields are compared exactly.

`legacy-session.json.gz` is an actual gzip archive written by the original
TypeScript store. It is read, restored and archived again by the Go tests.

The fixed fixtures are test inputs, never runtime dependencies.

`TestNodeOracle` explicitly checks one intentional policy change against the
frozen `rebase revision` vector: an already confirmed resolved comment stays
resolved when only the overall version changes. The fixture bytes are preserved;
related changes and new agent replies still require review in separate regressions.

Remaining boundaries: the legacy free-text forms accepted by V8 `Date.parse`
are not exhaustive here; normal persisted ISO timestamps and the listed legacy
forms have fixed coverage. HTTP, CLI and persisted JSON reject isolated UTF-16
surrogates before Go's decoder can replace them. Malformed legacy files remain
unchanged and cannot be mutated; repair the original file before retrying.
Platforms whose `os.FileInfo` omits change-time disable
session caching and conservatively re-read the file.
