package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"logicmargin/internal/review"
)

// Exercise the CLI HTTP contract against the real persistence and transitions,
// with only the service's routing replaced by this small test adapter.
func storeServer(t *testing.T, store *review.Store) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/review-sessions")
		parts := strings.Split(strings.Trim(path, "/"), "/")
		id := parts[0]
		action := ""
		if len(parts) > 1 {
			action = parts[1]
		}
		var result any
		var err error
		if r.Method == "GET" {
			switch {
			case path == "":
				options := object{"state": r.URL.Query().Get("state")}
				if r.URL.Query().Has("context") {
					options["context"] = r.URL.Query().Get("context")
				}
				result, err = store.List(options)
			case action == "archive":
				result, err = store.GetArchive(id)
			default:
				result, err = store.Get(id, "")
			}
		} else {
			body := requestBody(t, r)
			switch {
			case path == "":
				result, err = store.Create(body["review"], "", body)
			case action == "mutations":
				result, err = store.Mutate(id, body, "")
			case action == "ack":
				result, err = store.Acknowledge(id, body, "")
			case action == "revise":
				result, err = store.Revise(id, body, "")
			case action == "baseline":
				result, err = store.AttachBaseline(id, body, "")
			case action == "cleanup":
				result, err = store.Cleanup(id, body)
			case action == "restore":
				result, err = store.Restore(id, body)
			default:
				t.Error("unhandled route", r.URL.Path)
				w.WriteHeader(404)
				return
			}
		}
		if err != nil {
			status := 500
			var e *review.Error
			if errors.As(err, &e) {
				status = e.Status
			}
			w.WriteHeader(status)
			respond(w, object{"error": err.Error()})
			return
		}
		respond(w, result)
	}))
}
func TestFullHTTPWorkflowWithRealStore(t *testing.T) {
	clearURLEnv(t)
	ctx := context.Background()
	store := review.NewStore(t.TempDir())
	defer store.Close()
	server := storeServer(t, store)
	defer server.Close()
	opts := Options{URL: server.URL, ConsumeSubmission: true}
	root, next := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()\nchargeAfterSuccess()\n")})
	addEvidence(next, "logic.go", "check()\nchargeAfterSuccess()", 2)
	initial := cloneObject(t, next)
	initial["revision"] = "r0"
	initial["comments"] = obj(fixtureSession(t)["review"])["comments"]
	for _, v := range arr(initial["comments"]) {
		obj(v)["revision"] = "r0"
	}
	reviewPath := jsonFile(t, filepath.Join(root, "review.json"), initial)
	started, _, _, err := runTest(t, ctx, []string{"start", reviewPath, "--source-root", root}, opts)
	if err != nil {
		t.Fatal(err)
	}
	id := str(started["sessionId"])
	if id == "" || started["round"] != float64(1) {
		t.Fatal(started)
	}
	baselineRoot, baseline := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()\nchargeBeforeSuccess()\n")})
	addEvidence(baseline, "logic.go", "check()\nchargeBeforeSuccess()", 2)
	baseline["revision"] = "before"
	baselinePath := jsonFile(t, filepath.Join(baselineRoot, "baseline.json"), baseline)
	attached, _, _, err := runTest(t, ctx, []string{"baseline", id, baselinePath, "--source-root", baselineRoot}, opts)
	if err != nil || attached["version"] != float64(2) {
		t.Fatal(attached, err)
	}
	current, err := store.Get(id, "")
	if err != nil {
		t.Fatal(err)
	}
	current, err = store.Finish(id, object{"kind": "feedback", "expectedVersion": current["version"], "submissionId": "feedback-1"}, "")
	if err != nil {
		t.Fatal(err)
	}
	mcp := opts
	mcp.ConsumeSubmission = false
	delivered, _, _, err := runTest(t, ctx, []string{"wait", id}, mcp)
	if err != nil || delivered["requiresAcknowledgement"] != true {
		t.Fatal(delivered, err)
	}
	current, err = store.Get(id, "")
	if err != nil || current["phase"] != "feedback-ready" {
		t.Fatal(current, err)
	}
	received, _, _, err := runTest(t, ctx, []string{"wait", id}, opts)
	if err != nil || obj(received["submission"])["id"] != "feedback-1" {
		t.Fatal(received, err)
	}
	_, _, _, err = runTest(t, ctx, []string{"reply", id, "comment-1", "--body", "已调整。\n\n请复核。"}, opts)
	if err != nil {
		t.Fatal(err)
	}
	comments, _, _, err := runTest(t, ctx, []string{"comments", id}, opts)
	if err != nil || obj(arr(comments["comments"])[0])["status"] != "needs-review" {
		t.Fatal(comments, err)
	}
	jsonFile(t, reviewPath, next)
	replies := jsonFile(t, filepath.Join(root, "replies.json"), []any{object{"commentId": "comment-1", "body": "本轮正式说明"}})
	revised, _, _, err := runTest(t, ctx, []string{"revise", id, reviewPath, "--source-root", root, "--base-round", "1", "--summary", "成功后扣费", "--unchanged-reason", "已核对原有流程", "--replies-file", replies}, opts)
	if err != nil || revised["round"] != float64(2) || revised["phase"] != "awaiting-review" {
		t.Fatal(revised, err)
	}
	current, err = store.Get(id, "")
	if err != nil {
		t.Fatal(err)
	}
	doc := obj(current["review"])
	b := obj(doc["baseline"])
	if firstEvidence(b)["code"] != "check()\nchargeBeforeSuccess()" || firstEvidence(doc)["code"] != "check()\nchargeAfterSuccess()" {
		t.Fatal("source capture mismatch")
	}
	comment := obj(arr(doc["comments"])[0])
	current, err = store.Mutate(id, object{"expectedVersion": current["version"], "round": current["round"], "revision": doc["revision"], "fingerprint": obj(doc["snapshot"])["fingerprint"], "mutations": []any{object{"kind": "set-status", "commentId": "comment-1", "from": comment["status"], "status": "resolved", "reviewedRevision": doc["revision"]}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	current, err = store.Finish(id, object{"kind": "approval", "expectedVersion": current["version"], "submissionId": "approval-2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	approved, _, _, err := runTest(t, ctx, []string{"wait", id, "--cleanup-on-approval"}, opts)
	if err != nil || approved["approved"] != true || approved["round"] != float64(2) {
		t.Fatal(approved, err)
	}
	archived, _, _, err := runTest(t, ctx, []string{"get", id}, opts)
	if err != nil || archived["phase"] != "approved" {
		t.Fatal(archived, err)
	}
	if !reflect.DeepEqual(cloneObject(t, obj(obj(archived["review"])["baseline"])), cloneObject(t, b)) {
		t.Fatal("baseline changed after archival")
	}
	listed, _, _, err := runTest(t, ctx, []string{"list", "--state", "archived"}, opts)
	if err != nil || len(arr(listed["sessions"])) != 1 {
		t.Fatal(listed, err)
	}
	restored, _, _, err := runTest(t, ctx, []string{"restore", id}, opts)
	if err != nil || restored["sessionId"] != id {
		t.Fatal(restored, err)
	}
	_, _, _, err = runTest(t, ctx, []string{"cleanup", id, "--mode", "delete", "--force"}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Get(id, ""); err == nil {
		t.Fatal("deleted session remains")
	}
}
func TestSourcePreparationAndBaselineModesStayOffline(t *testing.T) {
	clearURLEnv(t)
	root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("检查😀\n执行()\n")})
	addEvidence(doc, "logic.go", "检查😀\n执行()", 2)
	path := jsonFile(t, filepath.Join(root, "review.json"), doc)
	opts := Options{ResolveURL: func(context.Context) (string, error) {
		t.Error("offline preparation started daemon")
		return "", errors.New("unexpected daemon")
	}}
	result, _, _, err := runTest(t, context.Background(), []string{"verify", path, "--source-root", root}, opts)
	if err != nil || result["algorithm"] != "sha256-path-content-v1" {
		t.Fatal(result, err)
	}
	beforeRoot, before := sourceFixture(t, map[string][]byte{"logic.go": []byte("before()")})
	addEvidence(before, "logic.go", "before()", 1)
	baselinePath := jsonFile(t, filepath.Join(beforeRoot, "before.json"), before)
	result, _, _, err = runTest(t, context.Background(), []string{"verify", path, "--source-root", root, "--baseline-file", baselinePath, "--baseline-source-root", beforeRoot}, opts)
	if err != nil || obj(result["baseline"])["fingerprint"] != obj(before["snapshot"])["fingerprint"] {
		t.Fatal(result, err)
	}
	embedded := cloneObject(t, doc)
	embedded["baseline"] = before
	jsonFile(t, path, embedded)
	_, _, _, err = runTest(t, context.Background(), []string{"start", path, "--source-root", root}, opts)
	requireError(t, err, "核验修改前基线需要")
	jsonFile(t, path, doc)
	store := review.NewStore(t.TempDir())
	defer store.Close()
	server := storeServer(t, store)
	defer server.Close()
	result, _, _, err = runTest(t, context.Background(), []string{"start", path, "--source-root", root, "--baseline-review"}, Options{URL: server.URL})
	if err != nil || result["baselineReview"] != true {
		t.Fatal(result, err)
	}
	current, err := store.Get(str(result["sessionId"]), "")
	if err != nil {
		t.Fatal(err)
	}
	original := copyObject(obj(current["review"]))
	delete(original, "baseline")
	if !reflect.DeepEqual(original, obj(obj(current["review"])["baseline"])) {
		t.Fatal("baseline-review did not fix original B")
	}
	// A canceled context also prevents even offline work or help from proceeding.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Run(ctx, []string{"--help"}, io.Discard, io.Discard, Options{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestScopedStartAndStaleSourcesBeforeResolve(t *testing.T) {
	clearURLEnv(t)
	root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()")})
	addEvidence(doc, "logic.go", "check()", 1)
	doc["comments"] = obj(fixtureSession(t)["review"])["comments"]
	path := jsonFile(t, filepath.Join(root, "review.json"), doc)
	store := review.NewStore(t.TempDir())
	defer store.Close()
	server := storeServer(t, store)
	defer server.Close()
	calls := 0
	opts := Options{ResolveURL: func(context.Context) (string, error) { calls++; return server.URL, nil }}
	result, _, _, err := runTest(t, context.Background(), []string{"start", path, "--source-root", root, "--context", " thread:one ", "--cleanup-on-approval"}, opts)
	if err != nil || calls != 1 {
		t.Fatal(result, err, calls)
	}
	current, err := store.Get(str(result["sessionId"]), "")
	if err != nil || len(arr(obj(current["review"])["comments"])) != 0 || obj(current["scope"])["purpose"] != doc["description"] || obj(current["scope"])["context"] != "thread:one" || current["cleanupPolicy"] != "archive-on-approval" {
		t.Fatal(current, err)
	}
	obj(arr(obj(doc["snapshot"])["files"])[0])["sha256"] = strings.Repeat("0", 64)
	jsonFile(t, path, doc)
	_, _, _, err = runTest(t, context.Background(), []string{"start", path, "--source-root", root}, opts)
	requireError(t, err, "来源文件已变化")
	if calls != 1 {
		t.Fatal("stale sources started service")
	}
}
