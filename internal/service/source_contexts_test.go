package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
)

func contextHash(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }

func contextDocument(raw string) review.Object {
	content := normalizedContext(raw)
	code, _, _, _ := contextSlice(content, 3, 5)
	doc := precomputeSourceFixture(code)
	evidence := objectForComputation(arrayForComputation(objectForComputation(arrayForComputation(doc["nodes"])[0])["evidence"])[0])
	evidence["startLine"], evidence["endLine"] = 3, 5
	files := []any{review.Object{"path": "saved.go", "sha256": contextHash(raw)}}
	manifest, _ := json.Marshal(files)
	snapshot := objectForComputation(doc["snapshot"])
	snapshot["files"], snapshot["fingerprint"] = files, contextHash(string(manifest))
	return doc
}

func contextServer(t *testing.T) (*Server, review.Object, review.Object, review.Object, string, string) {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: review.NewStore(directory), derived: precompute.NewEngine(filepath.Join(directory, "derived")), contexts: sourcecontext.NewStore(filepath.Join(directory, "contexts"))}
	t.Cleanup(func() { s.derived.Close(); s.store.Close() })
	a := "\ufeffpackage saved\r\n\r\nfunc Run() {\r\n\tvalue := \"旧😀\"\r\n\t_ = value\r\n}\r\n"
	b := strings.Replace(a, "旧😀", "新😁", 1)
	before, after := contextDocument(a), contextDocument(b)
	after["baseline"] = before
	state, err := s.store.Create(after, "current", nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, state, before, after, a, b
}

func postContext(t *testing.T, s *Server, id string, input any, peer, host, origin string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/review-sessions/" + id + "/source-contexts"
	req := httptest.NewRequest("POST", "http://"+host+path, bytes.NewReader(body))
	req.RemoteAddr = peer
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	response := httptest.NewRecorder()
	if !s.servePrecompute(response, req, path) {
		t.Fatal("unhandled source-context route")
	}
	return response
}

func uploadContext(t *testing.T, s *Server, id string, doc review.Object, raw string, snapshot snapshotSelector) {
	t.Helper()
	input := sourceContextRequest{Snapshot: snapshot, Fingerprint: textForComputation(objectForComputation(doc["snapshot"])["fingerprint"]),
		Sources: []sourcecontext.Source{{Path: "saved.go", SHA256: contextHash(raw), Content: raw}}}
	response := postContext(t, s, id, input, "127.0.0.1:1234", "127.0.0.1:5173", "")
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
}

func TestSavedFullContextStructuresTruncatedRangesWithoutChangingReview(t *testing.T) {
	s, state, before, after, a, b := contextServer(t)
	id := textForComputation(state["id"])
	original, err := s.store.Get(id, "")
	if err != nil {
		t.Fatal(err)
	}
	ref := func(doc review.Object) evidenceReference {
		return referenceForWarm(objectForComputation(arrayForComputation(objectForComputation(arrayForComputation(doc["nodes"])[0])["evidence"])[0]))
	}
	input := diffRequest{BeforeSnapshot: snapshotSelector{Kind: "baseline"}, AfterSnapshot: snapshotSelector{Kind: "round", Round: 1}, Before: ref(before), After: ref(after)}
	path := "/api/review-sessions/" + id + "/precompute/structure"
	old := computationRequest(t, s, path, input)
	if old.Code != 200 || !strings.Contains(old.Body.String(), `"invalid-syntax"`) {
		t.Fatal("truncated fixture must demonstrate the old fallback", old.Code, old.Body.String())
	}
	uploadContext(t, s, id, before, a, snapshotSelector{Kind: "baseline"})
	uploadContext(t, s, id, after, b, snapshotSelector{Kind: "round", Round: 1})
	response := computationRequest(t, s, path, input)
	var result precompute.StructureResult
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Mode != "structural" {
		t.Fatal(response.Code, response.Body.String())
	}
	if result.Before.Digest != input.Before.Digest || result.After.Digest != input.After.Digest || len(result.Highlights.Before) == 0 || len(result.Highlights.After) == 0 {
		t.Fatal("context result must belong to the saved visible snippets", result)
	}
	context := s.structureSourceContext(context.Background(), id, after, input.After, strings.Join(strings.Split(normalizedContext(b), "\n")[2:5], "\n"))
	if context == nil || context.From != contextUnits("package saved\n\n") || context.To > contextUnits(normalizedContext(b)) {
		t.Fatal("BOM/CRLF/UTF16 projection is incorrect", context)
	}
	next, err := s.store.Get(id, "")
	if err != nil || !reflect.DeepEqual(original, next) {
		t.Fatal("capturing analysis context changed fixed review data", err)
	}
}

func TestSourceContextsRequireLocalVerifiedSnapshot(t *testing.T) {
	s, state, before, _, a, _ := contextServer(t)
	id := textForComputation(state["id"])
	base := sourceContextRequest{Snapshot: snapshotSelector{Kind: "baseline"}, Fingerprint: textForComputation(objectForComputation(before["snapshot"])["fingerprint"]), Sources: []sourcecontext.Source{{Path: "saved.go", SHA256: contextHash(a), Content: a}}}
	for _, tc := range []struct{ name, peer, host, origin string }{
		{"remote", "100.100.1.2:1234", "127.0.0.1:5173", ""},
		{"rebound host", "127.0.0.1:1234", "evil.test:5173", ""},
		{"cross origin", "127.0.0.1:1234", "127.0.0.1:5173", "http://evil.test"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := postContext(t, s, id, base, tc.peer, tc.host, tc.origin)
			if response.Code != 403 {
				t.Fatal(response.Code, response.Body.String())
			}
		})
	}
	for _, kind := range []string{"fingerprint", "sha", "content", "range", "snapshot"} {
		t.Run(kind, func(t *testing.T) {
			input := base
			input.Sources = append([]sourcecontext.Source(nil), base.Sources...)
			switch kind {
			case "fingerprint":
				input.Fingerprint = strings.Repeat("0", 64)
			case "sha":
				input.Sources[0].SHA256 = strings.Repeat("0", 64)
			case "content":
				input.Sources[0].Content += "changed"
			case "range":
				input.Sources[0].Path = "other.go"
			case "snapshot":
				input.Snapshot = snapshotSelector{Kind: "round", Round: 999}
			}
			response := postContext(t, s, id, input, "127.0.0.1:1234", "127.0.0.1:5173", "")
			if response.Code < 400 || response.Code >= 500 {
				t.Fatal(response.Code, response.Body.String())
			}
		})
	}
}

func TestContextNamespaceDoesNotAdmitNewUnverifiedRanges(t *testing.T) {
	s, state, before, _, a, _ := contextServer(t)
	id := textForComputation(state["id"])
	uploadContext(t, s, id, before, a, snapshotSelector{Kind: "baseline"})
	sha := contextHash(a)
	first := contextNamespace(id, before, "saved.go", sha)
	copy := contextDocument(a)
	copy["comments"] = []any{review.Object{"body": "UI-only discussion"}}
	if contextNamespace(id, copy, "saved.go", sha) != first {
		t.Fatal("comments invalidated admitted source identity")
	}
	evidence := objectForComputation(arrayForComputation(objectForComputation(arrayForComputation(copy["nodes"])[0])["evidence"])[0])
	evidence["startLine"], evidence["endLine"] = 4, 4
	evidence["code"], evidence["digest"] = "guessed source", contextHash("guessed source")
	if contextNamespace(id, copy, "saved.go", sha) == first {
		t.Fatal("new source ranges reused the admitted context namespace")
	}
	if context := s.structureSourceContext(context.Background(), id, copy, referenceForWarm(evidence), "guessed source"); context != nil {
		t.Fatal("unverified evidence obtained old context")
	}
	if contextNamespace("00000000-0000-4000-8000-000000000001", before, "saved.go", sha) == first {
		t.Fatal("context escaped its review session")
	}
}
