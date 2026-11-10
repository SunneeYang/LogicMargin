package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureSession(t *testing.T) object {
	doc := fixtureReview()
	doc["comments"] = []any{object{"id": "comment-1", "body": "请核对扣费顺序", "targets": []any{object{"kind": "review", "id": doc["id"]}}, "status": "open", "createdAt": "2026-11-02T00:00:00Z", "revision": doc["revision"]}}
	return object{"schemaVersion": float64(1), "id": "session-1", "version": float64(1), "round": float64(1), "phase": "awaiting-review", "createdAt": "2026-11-02T00:00:00Z", "updatedAt": "2026-11-02T00:00:00Z", "review": doc, "history": []any{}, "snapshots": []any{object{"round": float64(1), "openedAt": "2026-11-02T00:00:00Z", "review": cloneObject(t, doc)}}}
}
func record(t *testing.T, id, kind string, doc object) object {
	return object{"schemaVersion": float64(1), "kind": kind, "id": id, "createdAt": "2026-11-02T00:00:00Z", "review": cloneObject(t, doc)}
}
func runTest(t *testing.T, ctx context.Context, args []string, opts Options) (object, string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	err := Run(ctx, args, &out, &errOut, opts)
	var result object
	if out.Len() > 0 {
		if jsonErr := json.Unmarshal(out.Bytes(), &result); jsonErr != nil {
			t.Fatalf("invalid JSON %q: %v", out.String(), jsonErr)
		}
	}
	return result, out.String(), errOut.String(), err
}
func requestBody(t *testing.T, r *http.Request) object {
	t.Helper()
	var v object
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		t.Error(err)
	}
	return v
}
func respond(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func jsonFile(t *testing.T, path string, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func clearURLEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"LOGIC_MARGIN_URL", "LOGIC_MARGIN_PUBLIC_URL"} {
		old, ok := os.LookupEnv(key)
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if ok {
				_ = os.Setenv(key, old)
			} else {
				_ = os.Unsetenv(key)
			}
		})
	}
}

func TestWaitDeliveryAndExplicitAcknowledgement(t *testing.T) {
	clearURLEnv(t)
	for _, mode := range []string{"CLI", "MCP", "CLI-no-consume"} {
		t.Run(mode, func(t *testing.T) {
			consume := mode == "CLI"
			current := fixtureSession(t)
			submitted := record(t, "feedback-1", "logic-margin-feedback", obj(current["review"]))
			reads, acks := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/ack") {
					acks++
					if b := requestBody(t, r); b["submissionId"] != submitted["id"] {
						t.Error(b)
					}
					current["phase"] = "agent-working"
					current["acknowledgedSubmission"] = submitted["id"]
					respond(w, current)
					return
				}
				reads++
				if reads == 1 || !r.URL.Query().Has("afterVersion") {
					respond(w, current)
					return
				}
				if r.URL.Query().Get("afterVersion") != "1" || r.URL.Query().Get("waitMs") != "25000" {
					t.Error(r.URL.String())
				}
				current["history"] = []any{submitted}
				current["phase"] = "feedback-ready"
				current["version"] = float64(2)
				respond(w, current)
			}))
			defer server.Close()
			args := []string{"wait", "session-1"}
			if mode == "CLI-no-consume" {
				args = append(args, "--no-consume")
			}
			result, _, _, err := runTest(t, context.Background(), args, Options{URL: server.URL, ConsumeSubmission: mode != "MCP"})
			if err != nil {
				t.Fatal(err)
			}
			if reads != 2 || acks != map[bool]int{true: 1, false: 0}[consume] || result["approved"] != false || obj(result["submission"])["id"] != "feedback-1" {
				t.Fatal(reads, acks, result)
			}
			if (result["requiresAcknowledgement"] == true) == consume {
				t.Fatal(result)
			}
			if _, ok := obj(obj(result["submission"])["review"])["nodes"]; ok {
				t.Fatal("graph leaked")
			}
			if !consume {
				_, _, _, err := runTest(t, context.Background(), []string{"ack", "session-1", "feedback-1"}, Options{URL: server.URL})
				if err != nil || acks != 1 {
					t.Fatal(err, acks)
				}
			}
		})
	}
}
func TestWaitCursorRoundBoundaryTimeoutAndEarlierFeedback(t *testing.T) {
	clearURLEnv(t)
	current := fixtureSession(t)
	first := record(t, "first", "logic-margin-feedback", obj(current["review"]))
	second := record(t, "second", "logic-margin-feedback", obj(current["review"]))
	current["history"] = []any{first, second}
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			t.Error("MCP consumed feedback")
		}
		if r.URL.Query().Has("afterVersion") {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(5 * time.Millisecond):
				w.WriteHeader(204)
				return
			}
		}
		respond(w, current)
	}))
	defer server.Close()
	opts := Options{URL: server.URL}
	result, _, _, err := runTest(t, context.Background(), []string{"wait", "session-1"}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if obj(result["submission"])["id"] != "second" || obj(obj(arr(result["earlierSubmissions"])[0])["submission"])["id"] != "first" {
		t.Fatal(result)
	}
	_, _, _, err = runTest(t, context.Background(), []string{"wait", "session-1", "--after", "missing"}, opts)
	requireError(t, err, "找不到提交游标")
	current["acknowledgedSubmission"] = "first"
	current["round"] = float64(2)
	current["snapshots"] = append(arr(current["snapshots"]), object{"round": float64(2), "openedAt": "2026-11-02T00:00:00Z", "afterSubmission": "second", "review": cloneObject(t, obj(current["review"]))})
	_, out, _, err := runTest(t, context.Background(), []string{"resume", "session-1", "--wait", "--timeout", "0.04"}, opts)
	requireError(t, err, "等待审查超时")
	if out != "" || posts != 0 {
		t.Fatal(out, posts)
	}
	_, out, _, err = runTest(t, context.Background(), []string{"resume", "session-1", "--wait", "--no-consume", "--timeout", "0.04"}, Options{URL: server.URL, ConsumeSubmission: true})
	requireError(t, err, "等待审查超时")
	if out != "" || posts != 0 {
		t.Fatal("CLI fallback consumed on timeout", out, posts)
	}
	current["history"] = append(arr(current["history"]), record(t, "third", "logic-margin-feedback", obj(current["review"])))
	result, _, _, err = runTest(t, context.Background(), []string{"wait", "session-1"}, opts)
	if err != nil || result["round"] != float64(2) || obj(result["submission"])["id"] != "third" || result["earlierSubmissions"] != nil {
		t.Fatal(result, err)
	}
}
func TestApprovalOutputBeforeCleanupAndMCPCleanupPending(t *testing.T) {
	clearURLEnv(t)
	for _, mode := range []string{"success", "conflict", "MCP", "CLI-no-consume", "historical"} {
		t.Run(mode, func(t *testing.T) {
			current := fixtureSession(t)
			feedback := record(t, "feedback", "logic-margin-feedback", obj(current["review"]))
			obj(current["review"])["comments"] = []any{}
			approval := record(t, "approval", "logic-margin-approval", obj(current["review"]))
			current["history"] = []any{feedback, approval}
			current["phase"] = "approved"
			current["cleanupPolicy"] = "archive-on-approval"
			current["scope"] = object{"context": "thread:test", "purpose": "验收"}
			if mode == "historical" {
				current["round"] = float64(2)
				current["snapshots"] = append(arr(current["snapshots"]), object{"round": float64(2), "afterSubmission": "approval", "openedAt": "2026-11-02T00:00:00Z", "review": cloneObject(t, obj(current["review"]))})
			}
			var out, errOut bytes.Buffer
			cleanups := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/cleanup") {
					cleanups++
					var result object
					if err := json.Unmarshal(out.Bytes(), &result); err != nil || result["approved"] != true {
						t.Error("approval was not output before cleanup", err)
					}
					body := requestBody(t, r)
					if body["expectedVersion"] != float64(1) || body["mode"] != "archive" {
						t.Error(body)
					}
					if mode == "conflict" {
						w.WriteHeader(409)
						respond(w, object{"error": "会话已有更新"})
						return
					}
					respond(w, object{"id": "session-1", "mode": "archive"})
					return
				}
				if r.Method != "GET" {
					t.Error("unexpected acknowledgement")
				}
				respond(w, current)
			}))
			defer server.Close()
			args := []string{"wait", "session-1", "--after", "feedback"}
			if mode == "CLI-no-consume" {
				args = append(args, "--no-consume")
			}
			err := Run(context.Background(), args, &out, &errOut, Options{URL: server.URL, ConsumeSubmission: mode != "MCP"})
			if mode == "conflict" {
				requireError(t, err, "已输出通过结果，但自动归档失败")
			} else if err != nil {
				t.Fatal(err)
			}
			var result object
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			summary := obj(obj(result["submission"])["review"])
			if result["approved"] != true || summary["resolvedCommentCount"] != float64(0) || summary["comments"] != nil || obj(summary["snapshot"])["files"] != nil {
				t.Fatal(result)
			}
			if mode == "MCP" || mode == "CLI-no-consume" {
				if cleanups != 0 || result["cleanupPending"] != true {
					t.Fatal(cleanups, result)
				}
			} else if mode == "historical" {
				if cleanups != 0 || !strings.Contains(errOut.String(), "跳过自动归档") {
					t.Fatal(cleanups, errOut.String())
				}
			} else if cleanups != 1 {
				t.Fatal(cleanups)
			}
		})
	}
}
func TestAllHTTPPathsCarryCancellation(t *testing.T) {
	clearURLEnv(t)
	cases := []struct {
		name  string
		args  []string
		block string
	}{
		{"initial", []string{"get", "session-1"}, "initial"},
		{"poll", []string{"wait", "session-1"}, "poll"},
		{"no-consume-poll", []string{"wait", "session-1", "--no-consume"}, "poll"},
		{"ack", []string{"ack", "session-1", "feedback"}, "/ack"},
		{"automatic-ack", []string{"wait", "session-1"}, "/ack"},
		{"archive", []string{"get", "session-1"}, "/archive"},
		{"cleanup", []string{"cleanup", "session-1"}, "/cleanup"},
		{"restore", []string{"restore", "session-1"}, "/restore"},
		{"reply", []string{"reply", "session-1", "comment-1", "--body", "已修改"}, "/mutations"},
		{"list", []string{"list"}, "initial"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := fixtureSession(t)
			if tc.name == "automatic-ack" {
				current["history"] = []any{record(t, "feedback", "logic-margin-feedback", obj(current["review"]))}
			}
			blocked := make(chan struct{})
			canceled := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.block == "initial" || tc.block == "poll" && r.URL.Query().Has("afterVersion") || strings.HasSuffix(r.URL.Path, tc.block) {
					if r.Method == "POST" {
						_, _ = io.Copy(io.Discard, r.Body)
					}
					close(blocked)
					<-r.Context().Done()
					close(canceled)
					return
				}
				if tc.block == "/archive" {
					w.WriteHeader(410)
					respond(w, object{"error": "archived"})
					return
				}
				respond(w, current)
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- Run(ctx, tc.args, io.Discard, io.Discard, Options{URL: server.URL, ConsumeSubmission: true})
			}()
			select {
			case <-blocked:
			case <-time.After(2 * time.Second):
				t.Fatal("request never blocked")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cancellation lost")
			}
			select {
			case <-canceled:
			case <-time.After(2 * time.Second):
				t.Fatal("HTTP request not canceled")
			}
		})
	}
}

func TestNoConsumeRequiresWaiting(t *testing.T) {
	clearURLEnv(t)
	for _, args := range [][]string{
		{"wait", "id", "--no-consume"},
		{"start", "review.json", "--wait", "--no-consume"},
		{"resume", "id", "--wait", "--no-consume"},
		{"revise", "id", "review.json", "--base-round", "1", "--summary", "changed", "--wait", "--no-consume"},
	} {
		p, o, _, err := parseArgs(args, Options{})
		if err != nil {
			t.Fatal(args, err)
		}
		if err := validateArgs(p, o); err != nil {
			t.Fatal(args, err)
		}
	}
	for _, args := range [][]string{{"get", "id", "--no-consume"}, {"list", "--no-consume"}, {"start", "review.json", "--no-consume"}, {"resume", "id", "--no-consume"}, {"revise", "id", "review.json", "--base-round", "1", "--summary", "changed", "--no-consume"}} {
		err := Run(t.Context(), args, io.Discard, io.Discard, Options{ResolveURL: func(context.Context) (string, error) {
			t.Error("invalid no-consume invoked daemon", args)
			return "", errors.New("bad")
		}})
		requireError(t, err, "--no-consume")
	}
}

func TestResolveURLPrecedenceAndValidationOrder(t *testing.T) {
	clearURLEnv(t)
	current := fixtureSession(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, current) }))
	defer server.Close()
	opts := Options{ResolveURL: func(context.Context) (string, error) { calls++; return server.URL, nil }}
	for _, args := range [][]string{{"get", "id", "--wait"}, {"revise", "id", "missing"}, {"start", "missing.json"}, {"verify", "missing.json"}} {
		_, _, _, err := runTest(t, context.Background(), args, opts)
		if err == nil || calls != 0 {
			t.Fatal(args, err, calls)
		}
	}
	result, _, _, err := runTest(t, context.Background(), []string{"resume", "session-1"}, opts)
	if err != nil || calls != 1 || result["url"] != server.URL+"/?session=session-1" {
		t.Fatal(result, err, calls)
	}
	opts.URL = "http://127.0.0.1:1"
	result, _, _, err = runTest(t, context.Background(), []string{"resume", "session-1", "--url", server.URL, "--public-url", "http://100.1.2.3:5173"}, opts)
	if err != nil || calls != 1 || result["url"] != "http://100.1.2.3:5173/?session=session-1" {
		t.Fatal(result, err, calls)
	}
	t.Setenv("LOGIC_MARGIN_URL", server.URL)
	t.Setenv("LOGIC_MARGIN_PUBLIC_URL", "http://100.2.3.4:5173")
	result, _, _, err = runTest(t, context.Background(), []string{"resume", "session-1"}, opts)
	if err != nil || calls != 1 || result["url"] != "http://100.2.3.4:5173/?session=session-1" {
		t.Fatal(result, err, calls)
	}
}
func TestHelpAndInvalidOptions(t *testing.T) {
	clearURLEnv(t)
	for _, args := range [][]string{nil, {"help"}, {"--help"}, {"start", "--help"}} {
		var out bytes.Buffer
		if err := Run(context.Background(), args, &out, io.Discard, Options{}); err != nil || !strings.Contains(out.String(), "baseline <sessionId>") || !strings.Contains(out.String(), "Replies never resolve") || !strings.Contains(out.String(), "--no-consume") {
			t.Fatal(err, out.String())
		}
	}
	bad := [][]string{{"resolve", "id"}, {"get", "id", "--wait"}, {"wait", "id", "--timeout", "0"}, {"get", "id", "--url", "file:///tmp/review"}, {"get", "id", "--url", "http://u:p@host"}, {"get", "id", "--url", "http://host/?x=1"}, {"get", "id", "--url", "http://host/#fragment"}, {"get", "id", "--url", "http://host:99999"}, {"get", "id", "--url", "http://host", "--url", "http://host"}, {"get", "id", "--unknown"}, {"get", "id", "--url"}, {"reply", "id", "c", "--body", "a", "--body-file", "b"}, {"revise", "id", "file"}, {"revise", "id", "file", "--base-round", "1", "--summary", " "}, {"verify", "file", "--wait"}, {"get", "id", "--source-root", "."}, {"get", "id", "--summary", "x"}, {"start", "file", "--replies-file", "r"}, {"get", "id", "--base-round", "1"}, {"revise", "id", "file", "--base-round", "1.5"}, {"get", "id", "--purpose", "x"}, {"resume", "id", "--cleanup-on-approval"}, {"get", "id", "--force"}, {"list", "--state", "bad"}, {"cleanup", "id", "--mode", "bad"}, {"start", "file", "--baseline-review", "--baseline-source-root", "."}, {"baseline", "id", "file"}}
	for _, args := range bad {
		err := Run(context.Background(), args, io.Discard, io.Discard, Options{ResolveURL: func(context.Context) (string, error) {
			t.Error("invalid args invoked daemon", args)
			return "", errors.New("bad")
		}})
		if err == nil {
			t.Error("accepted", args)
		}
	}
}

func TestJSNumberOptions(t *testing.T) {
	clearURLEnv(t)
	for _, value := range []string{"1", "+1", "1.", "1e2", "0x10", "0b10", "0o10", "51"} {
		_, _, _, err := parseArgs([]string{"revise", "id", "path", "--base-round", value}, Options{})
		if err != nil {
			t.Fatal(value, err)
		}
	}
	for _, value := range []string{"1_000", "0x_1", "1p2", "1.5", "9007199254740992", "-0x1", "Inf", "NaN"} {
		_, _, _, err := parseArgs([]string{"revise", "id", "path", "--base-round", value}, Options{})
		if err == nil {
			t.Fatal("accepted", value)
		}
	}
	_, o, _, err := parseArgs([]string{"wait", "id", "--timeout", "0x10000000000000000"}, Options{})
	if err != nil || o.timeout <= 0 {
		t.Fatal(o, err)
	}
}

func TestCombinedBaselineSizeRejectedBeforeNetworkOrDaemon(t *testing.T) {
	clearURLEnv(t)
	root, current := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()\n")})
	addEvidence(current, "logic.go", "check()", 1)
	baseline := cloneObject(t, current)
	for _, doc := range []object{current, baseline} {
		nodes := arr(doc["nodes"])
		for i := 0; i < 540; i++ {
			node := cloneObject(t, obj(nodes[0]))
			node["id"] = fmt.Sprintf("padding-%d", i)
			node["evidence"] = []any{}
			node["detail"] = strings.Repeat("x", 10000)
			nodes = append(nodes, node)
		}
		doc["nodes"] = nodes
		raw, _ := json.Marshal(doc)
		if len(raw) >= maxFileBytes {
			t.Fatal("individual fixture exceeds review limit")
		}
	}
	currentPath := jsonFile(t, filepath.Join(root, "current.json"), current)
	baselinePath := jsonFile(t, filepath.Join(root, "baseline.json"), baseline)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }))
	defer server.Close()
	opts := Options{ResolveURL: func(context.Context) (string, error) { calls++; return server.URL, nil }}
	err := Run(t.Context(), []string{"start", currentPath, "--source-root", root, "--baseline-file", baselinePath, "--baseline-source-root", root}, io.Discard, io.Discard, opts)
	requireError(t, err, "合计超过10MB")
	if calls != 0 {
		t.Fatal("size validation caused network/daemon side effects", calls)
	}
}

func TestRevisionRound51And2001RepliesReachHTTPPayload(t *testing.T) {
	clearURLEnv(t)
	root, next := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()\n")})
	addEvidence(next, "logic.go", "check()", 1)
	current := fixtureSession(t)
	current["round"] = float64(51)
	obj(arr(current["snapshots"])[0])["round"] = float64(51)
	file := jsonFile(t, filepath.Join(root, "next.json"), next)
	replies := make([]any, 2001)
	for i := range replies {
		replies[i] = object{"commentId": fmt.Sprintf("comment-%d", i), "body": "已核对"}
	}
	repliesPath := jsonFile(t, filepath.Join(root, "replies.json"), replies)
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			if !strings.HasSuffix(r.URL.Path, "/revise") {
				t.Error(r.URL.Path)
			}
			payload := requestBody(t, r)
			if obj(payload["publication"])["baseRound"] != float64(51) || len(arr(payload["replies"])) != 2001 {
				t.Error("publication payload lost round or replies")
			}
			current["round"] = float64(52)
			current["review"] = payload["review"]
		}
		respond(w, current)
	}))
	defer server.Close()
	result, _, _, err := runTest(t, t.Context(), []string{"revise", "session-1", file, "--source-root", root, "--base-round", "51", "--summary", "继续复核", "--replies-file", repliesPath}, Options{URL: server.URL})
	if err != nil || result["round"] != float64(52) || posts != 1 {
		t.Fatal(result, err, posts)
	}
}
