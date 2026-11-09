package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
)

func TestVerifySourcesWithContextsPreservesRawBytesAndReport(t *testing.T) {
	entries := map[string][]byte{
		"src/logic.go": []byte("\ufefffirst\r\nsecond\r\n"),
		"unused.go":    []byte("unused"), "notes.md": []byte("first\nnotes"),
		"binary.ts": []byte("first\n\x00"),
		"large.ts":  []byte("first\n" + strings.Repeat("x", sourcecontext.MaxFileBytes)),
	}
	for _, ext := range []string{"js", "mjs", "cjs", "jsx", "ts", "tsx"} {
		entries["source."+ext] = []byte("first\nrest")
	}
	root, doc := sourceFixture(t, entries)
	var refs []any
	for p := range entries {
		if p == "unused.go" {
			continue
		}
		addEvidence(doc, p, "first", 1)
		refs = append(refs, firstEvidence(doc))
	}
	obj(arr(doc["nodes"])[0])["evidence"] = refs
	oldDoc := cloneObject(t, doc)
	oldReport, err := VerifySources(context.Background(), oldDoc, root)
	if err != nil {
		t.Fatal(err)
	}
	report, contexts, err := VerifySourcesWithContexts(context.Background(), doc, root)
	if err != nil {
		t.Fatal(err)
	}
	delete(report, "checkedAt")
	delete(oldReport, "checkedAt")
	if !reflect.DeepEqual(report, oldReport) || !reflect.DeepEqual(doc, oldDoc) {
		t.Fatal("legacy report or code capture changed")
	}
	if len(contexts) != 7 {
		t.Fatal("wrong eligible context count", len(contexts))
	}
	for _, source := range contexts {
		if source.Content != string(entries[source.Path]) || source.SHA256 != digest(entries[source.Path]) {
			t.Fatal("raw bytes changed", source.Path)
		}
		if err := os.WriteFile(filepath.Join(root, source.Path), []byte("new current workspace"), 0600); err != nil {
			t.Fatal(err)
		}
		if source.Content != string(entries[source.Path]) {
			t.Fatal("captured context changed")
		}
	}
	encoded, _ := json.Marshal(doc)
	if strings.Contains(string(encoded), "second") || strings.Contains(string(encoded), "\"content\"") {
		t.Fatal("full source embedded in document")
	}
}

func TestVerifySourcesWithContextsIsAtomicOnFailure(t *testing.T) {
	for _, failure := range []string{"hash", "fingerprint", "utf8", "snippet", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			root, doc := sourceFixture(t, map[string][]byte{"a.go": []byte("first"), "z.go": []byte("first")})
			addEvidence(doc, "a.go", "first", 1)
			first := firstEvidence(doc)
			addEvidence(doc, "z.go", "first", 1)
			obj(arr(doc["nodes"])[0])["evidence"] = []any{first, firstEvidence(doc)}
			ctx := context.Background()
			switch failure {
			case "hash":
				if err := os.WriteFile(filepath.Join(root, "z.go"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "fingerprint":
				obj(doc["snapshot"])["fingerprint"] = strings.Repeat("0", 64)
			case "utf8":
				if err := os.WriteFile(filepath.Join(root, "z.go"), []byte{0xff}, 0600); err != nil {
					t.Fatal(err)
				}
				for _, v := range arr(obj(doc["snapshot"])["files"]) {
					if obj(v)["path"] == "z.go" {
						obj(v)["sha256"] = digest([]byte{0xff})
					}
				}
			case "snippet":
				first["digest"] = strings.Repeat("0", 64)
			case "cancel":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			before := cloneObject(t, doc)
			if report, sources, err := VerifySourcesWithContexts(ctx, doc, root); err == nil || report != nil || len(sources) != 0 {
				t.Fatal("partial verification exposed", report, len(sources), err)
			}
			if !reflect.DeepEqual(doc, before) {
				t.Fatal("failed verification changed document")
			}
		})
	}
}

func TestContextUploadLocalPeerProxyRedirectAndOldService(t *testing.T) {
	for _, base := range []string{"http://example.com", "http://127.0.0.1.example.com", "http://192.168.1.1", "http://100.64.0.1", "http://localhost.evil", "http://user@localhost", "http://localhost?a=b", "ftp://localhost"} {
		if client := sourceContextClient(base); client != nil {
			client.CloseIdleConnections()
			t.Fatal("accepted remote or invalid URL", base)
		}
	}
	for _, base := range []string{"http://127.0.0.1", "http://[::1]", "http://localhost"} {
		client := sourceContextClient(base)
		if client == nil {
			t.Fatal("rejected loopback", base)
		}
		client.CloseIdleConnections()
	}
	var leaked atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Add(1)
		respond(w, object{"sourceContextVersion": 1})
	}))
	defer sink.Close()
	t.Setenv("HTTP_PROXY", sink.URL)
	t.Setenv("HTTPS_PROXY", sink.URL)
	uploads := []contextUpload{{object{"kind": "round", "round": float64(1)}, digest([]byte("manifest")), []sourcecontext.Source{{Path: "a.go", SHA256: digest([]byte("private")), Content: "private"}}}}
	for _, mode := range []string{"old", "probe-redirect", "post-redirect", "large-probe"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/precompute" {
					switch mode {
					case "old":
						respond(w, object{"version": 1})
						return
					case "probe-redirect":
						http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
						return
					case "large-probe":
						_, _ = w.Write([]byte(strings.Repeat("x", maxContextResponseBytes+1)))
						return
					}
					respond(w, object{"sourceContextVersion": 1})
					return
				}
				if mode != "post-redirect" {
					t.Error("old service received full source")
				}
				http.Redirect(w, r, sink.URL, http.StatusTemporaryRedirect)
			}))
			defer server.Close()
			status := uploadSourceContexts(context.Background(), server.URL, "id", uploads)
			if mode == "post-redirect" {
				if status["status"] != "partial" {
					t.Fatal(status)
				}
			} else if status != nil {
				t.Fatal("unsupported server produced warning", status)
			}
		})
	}
	if leaked.Load() != 0 {
		t.Fatal("proxy or redirect leaked request")
	}
	if got := uploadSourceContexts(context.Background(), "http://example.com", "id", uploads); got != nil {
		t.Fatal(got)
	}
}

func TestContextUploadBoundedConcurrencyAndWarmBarrier(t *testing.T) {
	var active, maximum, completed atomic.Int32
	var release sync.Once
	ready := make(chan struct{})
	want := []sourcecontext.Source{
		{Path: "a.go", SHA256: digest([]byte("\ufeffa\r\n")), Content: "\ufeffa\r\n"},
		{Path: "b.ts", SHA256: digest([]byte("b")), Content: "b"},
		{Path: "c.js", SHA256: digest([]byte("c")), Content: "c"},
	}
	var saved sync.Map
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/precompute" {
			respond(w, object{"sourceContextVersion": 1})
			return
		}
		if r.URL.Path != "/api/review-sessions/id/source-contexts" || r.Method != "POST" {
			t.Error(r.URL.Path)
		}
		for _, header := range []string{"Forwarded", "X-Forwarded-For", "X-Real-IP"} {
			if r.Header.Get(header) != "" {
				t.Error("proxy header sent", header)
			}
		}
		body := requestBody(t, r)
		if obj(body["snapshot"])["kind"] != "round" || obj(body["snapshot"])["round"] != float64(3) || body["fingerprint"] != "fingerprint" {
			t.Error(body["snapshot"], body["fingerprint"])
		}
		if body["warm"] == true {
			if completed.Load() != int32(len(want)) || len(arr(body["sources"])) != 0 {
				t.Error("warm preceded uploads")
			}
			respond(w, object{"ok": true})
			return
		}
		if len(arr(body["sources"])) != 1 {
			t.Error("batched sources")
		}
		source := obj(arr(body["sources"])[0])
		saved.Store(str(source["path"]), source)
		n := active.Add(1)
		defer active.Add(-1)
		for n > maximum.Load() {
			old := maximum.Load()
			if n <= old || maximum.CompareAndSwap(old, n) {
				break
			}
		}
		if n == 2 {
			release.Do(func() { close(ready) })
		}
		select {
		case <-ready:
		case <-r.Context().Done():
			return
		}
		completed.Add(1)
		respond(w, object{"ok": true})
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status := uploadSourceContexts(ctx, server.URL, "id", []contextUpload{{object{"kind": "round", "round": float64(3)}, "fingerprint", want}})
	if status["status"] != "uploaded" || maximum.Load() != 2 {
		t.Fatal(status, maximum.Load())
	}
	for _, source := range want {
		raw, ok := saved.Load(source.Path)
		if !ok || obj(raw)["content"] != source.Content || obj(raw)["sha256"] != source.SHA256 {
			t.Fatal("source changed", source.Path)
		}
	}
}

func TestContextProbeTimesOutAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	uploads := []contextUpload{{object{"kind": "baseline"}, "fingerprint", []sourcecontext.Source{{Path: "a.go", Content: "a", SHA256: digest([]byte("a"))}}}}
	start := time.Now()
	if status := uploadSourceContexts(context.Background(), server.URL, "id", uploads); status != nil {
		t.Fatal(status)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatal("probe exceeded two-second bound", elapsed)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if status := uploadSourceContexts(ctx, server.URL, "id", uploads); status != nil {
		t.Fatal(status)
	}
	client := sourceContextClient(server.URL)
	defer client.CloseIdleConnections()
	if _, err := contextRequest(ctx, client, http.MethodGet, server.URL, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestPublishedContextUploadFailureDoesNotRepeatOrPollute(t *testing.T) {
	clearURLEnv(t)
	root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("first\nprivate hidden body")})
	addEvidence(doc, "logic.go", "first", 1)
	path := jsonFile(t, filepath.Join(root, "review.json"), doc)
	original, _ := os.ReadFile(path)
	store := review.NewStore(t.TempDir())
	defer store.Close()
	api := storeServer(t, store)
	defer api.Close()
	var publications atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/precompute" {
			respond(w, object{"sourceContextVersion": 1})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/source-contexts") {
			w.WriteHeader(500)
			_, _ = w.Write([]byte("private hidden body"))
			return
		}
		if r.Method == "POST" && r.URL.Path == "/api/review-sessions" {
			publications.Add(1)
		}
		api.Config.Handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	result, out, _, err := runTest(t, context.Background(), []string{"start", path, "--source-root", root}, Options{URL: server.URL})
	if err != nil || publications.Load() != 1 || result["sessionId"] == "" || obj(result["analysisContext"])["status"] != "partial" {
		t.Fatal(result, err, publications.Load())
	}
	if strings.Contains(out, "private hidden body") {
		t.Fatal("source leaked in final error")
	}
	current, err := store.Get(str(result["sessionId"]), "")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(current)
	if strings.Contains(string(encoded), "private hidden body") {
		t.Fatal("full source persisted in session")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(original) {
		t.Fatal("source review file changed")
	}
	verified, _, _, err := runTest(t, context.Background(), []string{"verify", path, "--source-root", root}, Options{URL: server.URL})
	if err != nil || verified["analysisContext"] != nil || publications.Load() != 1 {
		t.Fatal(verified, err)
	}
}

func TestCLIUploadsSelectedPublishedSnapshotsBeforeWait(t *testing.T) {
	clearURLEnv(t)
	for _, mode := range []string{"start", "independent-baseline", "baseline-review", "baseline", "revise", "wait"} {
		t.Run(mode, func(t *testing.T) {
			currentRoot, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("first\ncurrent private body")})
			addEvidence(doc, "logic.go", "first", 1)
			baselineRoot, baseline := sourceFixture(t, map[string][]byte{"logic.go": []byte("first\nbaseline private body")})
			addEvidence(baseline, "logic.go", "first", 1)
			currentPath := jsonFile(t, filepath.Join(currentRoot, "review.json"), doc)
			baselinePath := jsonFile(t, filepath.Join(baselineRoot, "review.json"), baseline)
			current := fixtureSession(t)
			var mu sync.Mutex
			var received []object
			warmCount, publications := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/precompute" {
					respond(w, object{"sourceContextVersion": 1})
					return
				}
				if strings.HasSuffix(r.URL.Path, "/source-contexts") {
					body := requestBody(t, r)
					mu.Lock()
					if body["warm"] == true {
						warmCount++
					} else {
						received = append(received, body)
					}
					mu.Unlock()
					respond(w, object{"ok": true})
					return
				}
				if r.Method == "POST" {
					body := requestBody(t, r)
					publications++
					if strings.HasSuffix(r.URL.Path, "/baseline") {
						obj(current["review"])["baseline"] = body["baseline"]
					} else {
						current["review"] = body["review"]
					}
					if mode == "revise" {
						current["round"] = float64(2)
					}
					if mode == "baseline-review" {
						current["baselineReview"] = true
					}
					current["snapshots"] = []any{object{"round": current["round"], "openedAt": current["createdAt"], "review": cloneObject(t, obj(current["review"]))}}
					// The published source must survive a workspace change before upload.
					if err := os.WriteFile(filepath.Join(currentRoot, "logic.go"), []byte("changed after publish"), 0600); err != nil {
						t.Error(err)
					}
				}
				if mode == "wait" && r.Method == "GET" {
					mu.Lock()
					if warmCount != 1 {
						t.Error("wait began before upload and warm finished")
					}
					mu.Unlock()
					current["phase"] = "approved"
					current["version"] = float64(2)
					current["history"] = []any{record(t, "approval", "logic-margin-approval", obj(current["review"]))}
				}
				respond(w, current)
			}))
			defer server.Close()
			args := []string{"start", currentPath, "--source-root", currentRoot}
			switch mode {
			case "independent-baseline":
				args = append(args, "--baseline-file", baselinePath, "--baseline-source-root", baselineRoot)
			case "baseline-review":
				args = append(args, "--baseline-review")
			case "baseline":
				args = []string{"baseline", "session-1", baselinePath, "--source-root", baselineRoot}
			case "revise":
				args = []string{"revise", "session-1", currentPath, "--source-root", currentRoot, "--base-round", "1", "--summary", "updated", "--unchanged-reason", "checked"}
			case "wait":
				args = append(args, "--wait", "--timeout", "3")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result, output, _, err := runTest(t, ctx, args, Options{URL: server.URL})
			if err != nil || publications != 1 {
				t.Fatal(result, err, publications)
			}
			if strings.Contains(output, "private body") {
				t.Fatal("full source in output")
			}
			mu.Lock()
			defer mu.Unlock()
			wantCount := 1
			if mode == "baseline-review" || mode == "independent-baseline" {
				wantCount = 2
			}
			if len(received) != wantCount || warmCount != wantCount {
				t.Fatal(len(received), warmCount)
			}
			for _, body := range received {
				selector := obj(body["snapshot"])
				content := "first\ncurrent private body"
				fingerprint := obj(doc["snapshot"])["fingerprint"]
				if selector["kind"] == "baseline" {
					if mode == "baseline" || mode == "independent-baseline" {
						content = "first\nbaseline private body"
						fingerprint = obj(baseline["snapshot"])["fingerprint"]
					} else if mode != "baseline-review" {
						t.Fatal("unverified baseline uploaded")
					}
				} else if selector["kind"] != "round" || selector["round"] != current["round"] {
					t.Fatal(selector)
				}
				if body["fingerprint"] != fingerprint || len(arr(body["sources"])) != 1 {
					t.Fatal("snapshot mismatch")
				}
				saved := obj(arr(body["sources"])[0])
				if saved["content"] != content || saved["sha256"] != digest([]byte(content)) {
					t.Fatal("upload reread current workspace")
				}
			}
		})
	}
}
