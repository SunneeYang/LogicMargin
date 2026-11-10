# Fixed MCP contract

`mcp-catalog.json` was captured before deleting the Node backend, directly from
`registerReviewTools` in `server/mcp-tools.ts` at
`13e5150631dcfcedec9182b1de221815a8257d71`, using the official TypeScript SDK
`McpServer`, `InMemoryTransport` and `Client.listTools`. The full
`{name,description,inputSchema,annotations}` entries are sorted by tool name.
No Go output was used to produce the expected catalog.

SHA-256: `74ce5a765033f1ecf274303b35539a6655b5e7fc169afc120798f3fe35f47a99`.

`mcp-compat.mjs` keeps the official SDK **client** against the real Go service,
checking the fixed catalog, cancellation, timeout, feedback, acknowledgement and
shutdown. Run `go test ./internal/service` with repository `node_modules`
installed, or set `LOGIC_MARGIN_SDK_ROOT` to a private dependency checkout.
The Go-only catalog assertion runs without Node or npm dependencies.
