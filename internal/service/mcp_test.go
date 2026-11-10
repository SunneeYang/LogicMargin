package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"logicmargin/internal/review"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func connectMCP(t *testing.T, server *Server) *mcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "service-test-client", Version: "1.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp"}, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func toolText(result *mcp.CallToolResult) string {
	if result == nil {
		return ""
	}
	parts := []string{}
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			parts = append(parts, text.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func callTool(t *testing.T, client *mcp.ClientSession, name string, args review.Object) review.Object {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil || result.IsError {
		t.Fatalf("%s: %v %s", name, err, toolText(result))
	}
	var value review.Object
	if err := json.Unmarshal([]byte(toolText(result)), &value); err != nil {
		t.Fatal(name, err, toolText(result))
	}
	return value
}

func observeTool(s *Server, name string) <-chan struct{} {
	started := make(chan struct{}, 8)
	s.mcp.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if call, ok := request.(*mcp.CallToolRequest); ok && call.Params.Name == name {
				started <- struct{}{}
			}
			return next(ctx, method, request)
		}
	})
	return started
}

func awaitStarted(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("tool did not start")
	}
}

func TestMCPInitializeCatalogStrictValidationAndLargeBody(t *testing.T) {
	s := testServer(t)
	client := connectMCP(t, s)
	second := connectMCP(t, s)
	if client.ID() == second.ID() {
		t.Fatal("sessions were not isolated")
	}
	catalog, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range catalog.Tools {
		names = append(names, tool.Name)
		schema := tool.InputSchema.(map[string]any)
		if schema["additionalProperties"] != false {
			t.Fatal(tool.Name, schema)
		}
		if tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
			t.Fatal(tool.Name, tool.Annotations)
		}
		if tool.Name == "wait_review" && !tool.Annotations.ReadOnlyHint {
			t.Fatal(tool.Annotations)
		}
		if tool.Name == "cleanup_review" && (tool.Annotations.DestructiveHint == nil || !*tool.Annotations.DestructiveHint) {
			t.Fatal(tool.Annotations)
		}
	}
	sort.Strings(names)
	want := []string{"acknowledge_review", "attach_review_baseline", "cleanup_review", "get_review", "list_reviews", "reply_review", "restore_review", "revise_review", "start_review", "verify_review", "wait_review"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatal(names)
	}
	for _, invalid := range []review.Object{
		{"review_file": "relative.json", "source_root": "/tmp", "purpose": "审查"},
		{"review_file": "/tmp/review.json", "source_root": "/tmp", "purpose": "审查", "url": "http://elsewhere.invalid"},
		{"review_file": "/tmp/review.json", "source_root": "/tmp", "purpose": "\ufeff "},
		{"review_file": "/tmp/review.json", "source_root": "/tmp", "purpose": strings.Repeat("😀", 5001)},
	} {
		result, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "start_review", Arguments: invalid})
		if err != nil || !result.IsError {
			t.Fatal(err, result)
		}
	}
	s.mcp.AddTool(&mcp.Tool{Name: "test_length", InputSchema: review.Object{"type": "object"}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct{ Text string }
		if err := json.Unmarshal(request.Params.Arguments, &input); err != nil {
			return nil, err
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: jsonNumber(len(input.Text))}}}, nil
	})
	result, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "test_length", Arguments: review.Object{"text": strings.Repeat("x", 5*1024*1024)}})
	if err != nil || toolText(result) != "5242880" {
		t.Fatal(err, toolText(result))
	}
	if err := second.Ping(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		method, accept, version string
		status                  int
	}{
		{"POST", "application/json", "", 406}, {"GET", "application/json", "", 406},
		{"POST", "application/json, text/event-stream", "unknown", 400},
	} {
		status, _ := requestJSON(t, s, item.method, "/mcp", review.Object{"jsonrpc": "2.0", "id": 6, "method": "ping"}, map[string]string{"Mcp-Session-Id": second.ID(), "Accept": item.accept, "Mcp-Protocol-Version": item.version})
		if status != item.status {
			t.Fatal(item, status)
		}
	}
	oldID := client.ID()
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	status, _ := requestJSON(t, s, "POST", "/mcp", review.Object{"jsonrpc": "2.0", "id": 4, "method": "ping"}, map[string]string{"Mcp-Session-Id": oldID, "Accept": "application/json, text/event-stream"})
	if status != 404 {
		t.Fatal(status)
	}
}

func jsonNumber(value int) string { body, _ := json.Marshal(value); return string(body) }

func TestMCPSecurityAndBodyErrors(t *testing.T) {
	s := testServer(t)
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"raw-test","version":"1"}}}`
	for _, item := range []struct {
		method, body, mediaType, host, remote string
		extra                                 map[string]string
		status                                int
	}{
		{"POST", initialize, "application/json", "external.example", "127.0.0.1:4000", nil, 403},
		{"POST", initialize, "application/json", "127.0.0.1.evil", "127.0.0.1:4000", nil, 403},
		{"POST", initialize, "application/json", "127.0.0.1:99999", "127.0.0.1:4000", nil, 403},
		{"POST", initialize, "application/json", "127.0.0.1:5173", "100.64.0.10:4000", nil, 403},
		{"POST", initialize, "application/json", "127.0.0.1:5173", "127.0.0.1:4000", map[string]string{"Origin": "null"}, 403},
		{"POST", initialize, "application/json", "127.0.0.1:5173", "127.0.0.1:4000", map[string]string{"Origin": "https://127.0.0.1:5173"}, 403},
		{"POST", initialize, "application/json", "127.0.0.1:5173", "127.0.0.1:4000", map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		{"PUT", "", "", "127.0.0.1:5173", "127.0.0.1:4000", nil, 405},
		{"POST", "{}", "text/plain", "127.0.0.1:5173", "127.0.0.1:4000", nil, 415},
		{"POST", "{bad", "application/json", "127.0.0.1:5173", "127.0.0.1:4000", nil, 400},
		{"POST", `{"jsonrpc":"2.0","id":4,"method":"ping"}`, "application/json", "127.0.0.1:5173", "127.0.0.1:4000", nil, 400},
		{"POST", initialize, "application/json", "127.0.0.1:5173", "127.0.0.1:4000", map[string]string{"Mcp-Session-Id": "unknown"}, 404},
	} {
		r := httptest.NewRequest(item.method, "/mcp", strings.NewReader(item.body))
		r.Host = item.host
		r.RemoteAddr = item.remote
		r.Header.Set("Content-Type", item.mediaType)
		r.Header.Set("Accept", "application/json, text/event-stream")
		for key, value := range item.extra {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		if w.Code != item.status || !json.Valid(w.Body.Bytes()) {
			t.Fatalf("%+v: %d %s", item, w.Code, w.Body.String())
		}
	}
	for _, declared := range []bool{false, true} {
		r := httptest.NewRequest("POST", "/mcp", strings.NewReader(strings.Repeat("x", maxBodyBytes+1)))
		r.Host = "127.0.0.1:5173"
		r.RemoteAddr = "127.0.0.1:4000"
		r.Header.Set("Content-Type", "application/json")
		if !declared {
			r.ContentLength = -1
		}
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		if w.Code != 413 || !strings.Contains(w.Body.String(), "11 MB") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestMCPWaitDeliveryRequiresAcknowledgement(t *testing.T) {
	t.Setenv("LOGIC_MARGIN_URL", "http://unrelated.invalid")
	s := testServer(t)
	startedWait := observeTool(s, "wait_review")
	client := connectMCP(t, s)
	file, root := sourceFixture(t)
	verified := callTool(t, client, "verify_review", review.Object{"review_file": file, "source_root": root})
	if verified["fingerprint"] == nil {
		t.Fatal(verified)
	}
	started := callTool(t, client, "start_review", review.Object{"review_file": file, "source_root": root, "purpose": "核对人工提交", "context": "tools-context", "cleanup_on_approval": true})
	id := started["sessionId"].(string)
	path := sessionPrefix + "/" + id
	if !strings.Contains(started["url"].(string), "?session="+id) {
		t.Fatal(started)
	}
	if len(callTool(t, client, "list_reviews", review.Object{"context": "tools-context"})["sessions"].([]any)) != 1 {
		t.Fatal("list lost review")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	waiting := make(chan *mcp.CallToolResult, 1)
	waitErr := make(chan error, 1)
	go func() {
		result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "wait_review", Arguments: review.Object{"session_id": id}})
		waiting <- result
		waitErr <- err
	}()
	awaitStarted(t, startedWait)
	current := callTool(t, client, "get_review", review.Object{"session_id": id})
	doc := current["review"].(map[string]any)
	fingerprint := doc["snapshot"].(map[string]any)["fingerprint"]
	comment := review.Object{"id": "review-comment", "body": "失败出口也保留状态", "targets": []any{review.Object{"kind": "node", "id": "entry"}}, "status": "open", "createdAt": "2026-11-08T00:00:00Z", "revision": "r1"}
	status, value := requestJSON(t, s, "POST", path+"/mutations", review.Object{"round": 1, "revision": "r1", "fingerprint": fingerprint, "mutations": []any{review.Object{"kind": "add-comment", "comment": comment}}}, nil)
	saved := mustObject(t, status, value)
	select {
	case result := <-waiting:
		t.Fatal("saved comment completed wait", toolText(result))
	default:
	}
	status, value = requestJSON(t, s, "POST", path+"/finish", review.Object{"expectedVersion": saved["version"], "kind": "feedback"}, nil)
	submitted := mustObject(t, status, value)
	var result *mcp.CallToolResult
	select {
	case result = <-waiting:
	case <-ctx.Done():
		t.Fatal("wait failed to deliver submission")
	}
	if err := <-waitErr; err != nil || result.IsError {
		t.Fatal(err, toolText(result))
	}
	var received review.Object
	if err := json.Unmarshal([]byte(toolText(result)), &received); err != nil {
		t.Fatal(err)
	}
	submissionID := submitted["history"].([]any)[0].(map[string]any)["id"]
	if received["submission"].(map[string]any)["id"] != submissionID || received["requiresAcknowledgement"] != true {
		t.Fatal(received)
	}
	unread := callTool(t, client, "get_review", review.Object{"session_id": id})
	if unread["phase"] != "feedback-ready" || unread["acknowledgedSubmission"] != nil {
		t.Fatal(unread)
	}
	if callTool(t, client, "wait_review", review.Object{"session_id": id})["submission"].(map[string]any)["id"] != submissionID {
		t.Fatal("lost feedback was consumed")
	}
	claimed := callTool(t, client, "acknowledge_review", review.Object{"session_id": id, "submission_id": submissionID})
	if claimed["phase"] != "agent-working" {
		t.Fatal(claimed)
	}
	callTool(t, client, "reply_review", review.Object{"session_id": id, "comment_id": "review-comment", "body": "--help"})
	current = callTool(t, client, "get_review", review.Object{"session_id": id})
	if current["review"].(map[string]any)["comments"].([]any)[0].(map[string]any)["replies"].([]any)[0].(map[string]any)["body"] != "--help" {
		t.Fatal(current)
	}
	// Approval is delivered without archival even with cleanup-on-approval enabled.
	approvalSession := callTool(t, client, "start_review", review.Object{"review_file": file, "source_root": root, "purpose": "确认通过", "cleanup_on_approval": true})
	approvedID := approvalSession["sessionId"].(string)
	status, value = requestJSON(t, s, "POST", sessionPrefix+"/"+approvedID+"/finish", review.Object{"expectedVersion": 1, "kind": "approval"}, nil)
	_ = mustObject(t, status, value)
	approved := callTool(t, client, "wait_review", review.Object{"session_id": approvedID})
	if approved["approved"] != true || approved["cleanupPending"] != true {
		t.Fatal(approved)
	}
	if len(callTool(t, client, "list_reviews", review.Object{"state": "archived"})["sessions"].([]any)) != 0 {
		t.Fatal("delivery archived the approval")
	}
	callTool(t, client, "cleanup_review", review.Object{"session_id": approvedID})
	callTool(t, client, "get_review", review.Object{"session_id": approvedID})
	callTool(t, client, "restore_review", review.Object{"session_id": approvedID})
}

func TestMCPWaitCancellationDisconnectAndShutdown(t *testing.T) {
	for _, mode := range []string{"cancel", "disconnect", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			s := testServer(t)
			started := make(chan context.Context, 1)
			aborted := make(chan struct{})
			s.mcp.AddTool(&mcp.Tool{Name: "test_wait", InputSchema: review.Object{"type": "object"}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				started <- ctx
				<-ctx.Done()
				close(aborted)
				return toolError(ctx.Err().Error()), nil
			})
			client := connectMCP(t, s)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			result := make(chan error, 1)
			if mode == "disconnect" {
				go func() {
					request, _ := http.NewRequestWithContext(ctx, "POST", s.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"test_wait","arguments":{}}}`))
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Accept", "application/json, text/event-stream")
					request.Header.Set("Mcp-Session-Id", client.ID())
					request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
					response, err := http.DefaultClient.Do(request)
					if response != nil {
						_, _ = io.Copy(io.Discard, response.Body)
						_ = response.Body.Close()
					}
					result <- err
				}()
			} else {
				go func() {
					_, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "test_wait", Arguments: review.Object{}})
					result <- err
				}()
			}
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("wait did not start")
			}
			if mode == "shutdown" {
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				cancel()
			}
			select {
			case <-aborted:
			case <-time.After(time.Second):
				t.Fatal("orphan handler")
			}
			select {
			case err := <-result:
				if mode == "shutdown" {
					var rpcError *jsonrpc.Error
					if !errors.As(err, &rpcError) || rpcError.Code != -32000 || !strings.Contains(err.Error(), "正在停止") {
						t.Fatalf("shutdown only closed SSE instead of sending RPC error: %v", err)
					}
				} else if err == nil {
					t.Fatal("canceled request succeeded")
				}
			case <-time.After(time.Second):
				t.Fatal("client waited after shutdown/cancel")
			}
			if mode != "shutdown" {
				second := connectMCP(t, s)
				if err := second.Ping(t.Context(), nil); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

type cancelAfterMCPResponse struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w *cancelAfterMCPResponse) Write(body []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(body)
	if strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		w.cancel()
	}
	return n, err
}

func (w *cancelAfterMCPResponse) Flush() {
	w.ResponseRecorder.Flush()
	if strings.Contains(w.Body.String(), `"result"`) || strings.Contains(w.Body.String(), `"error"`) {
		w.cancel()
	}
}

func TestMCPCompletedResponseKeepsSession(t *testing.T) {
	for _, method := range []string{"tools/list", "tools/call"} {
		t.Run(method, func(t *testing.T) {
			s := testServer(t)
			client := connectMCP(t, s)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			request := httptest.NewRequest(http.MethodPost, s.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":40,"method":"`+method+`","params":{}}`)).WithContext(ctx)
			request.RemoteAddr = "127.0.0.1:12345"
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Accept", "application/json, text/event-stream")
			request.Header.Set("Mcp-Session-Id", client.ID())
			request.Header.Set("Mcp-Protocol-Version", "2025-11-25")
			writer := &cancelAfterMCPResponse{httptest.NewRecorder(), cancel}
			s.serveMCP(writer, request)
			if ctx.Err() == nil {
				t.Fatal("probe did not cancel after the final response")
			}
			if s.mcpSession(client.ID()) == nil {
				t.Fatal("completed response incorrectly disposed session when client closed its request")
			}
			if err := client.Ping(t.Context(), nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMCPResponseCompletion(t *testing.T) {
	for _, body := range []string{
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
	} {
		if !newMCPResponseWriter(httptest.NewRecorder(), []byte(body)).complete() {
			t.Fatal("notification or client response must not wait for a reply")
		}
	}
	writer := newMCPResponseWriter(httptest.NewRecorder(), []byte(`[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":"two","method":"ping"}]`))
	for _, message := range []string{
		`{"jsonrpc":"2.0","method":"notifications/message","params":{"data":"result"}}`,
		`{"jsonrpc":"2.0","id":3,"result":{}}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
	} {
		if _, err := writer.Write([]byte("event: message\ndata: " + message + "\n\n")); err != nil {
			t.Fatal(err)
		}
		if writer.complete() {
			t.Fatal("notification, unrelated ID or partial batch completed the response")
		}
	}
	if _, err := writer.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"two\",\"error\":{\"code\":-32601,\"message\":\"unknown method\"}}\n\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.FlushError(); err != nil || !writer.complete() {
		t.Fatalf("all batch results and errors must complete the response: %v", err)
	}
}

type failedMCPResponse struct{ *httptest.ResponseRecorder }

func (*failedMCPResponse) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (*failedMCPResponse) FlushError() error         { return io.ErrClosedPipe }

func TestMCPFailedResponseStaysIncomplete(t *testing.T) {
	writer := newMCPResponseWriter(&failedMCPResponse{httptest.NewRecorder()}, []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if _, err := writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`)); !errors.Is(err, io.ErrClosedPipe) || writer.complete() {
		t.Fatal("failed write must not complete the reply")
	}
	writer = newMCPResponseWriter(&failedMCPResponse{httptest.NewRecorder()}, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if err := writer.FlushError(); !errors.Is(err, io.ErrClosedPipe) || writer.complete() {
		t.Fatal("failed flush must not complete the response")
	}
}

func TestMCPActualWaitShutdownReturnsRPCError(t *testing.T) {
	s := testServer(t)
	started := observeTool(s, "wait_review")
	client := connectMCP(t, s)
	created := createReview(t, s, false)
	result := make(chan error, 1)
	go func() {
		_, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "wait_review", Arguments: review.Object{"session_id": created["id"]}})
		result <- err
	}()
	awaitStarted(t, started)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		var rpcError *jsonrpc.Error
		if !errors.As(err, &rpcError) || rpcError.Code != -32000 {
			t.Fatalf("missing shutdown RPC error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("wait_review hung after shutdown")
	}
}

func TestMCPBaselineAndRevision(t *testing.T) {
	s := testServer(t)
	client := connectMCP(t, s)
	file, root := sourceFixture(t)
	started := callTool(t, client, "start_review", review.Object{"review_file": file, "source_root": root, "purpose": "基线与新版"})
	id := started["sessionId"].(string)
	callTool(t, client, "attach_review_baseline", review.Object{"session_id": id, "baseline_file": file, "source_root": root})
	before := callTool(t, client, "get_review", review.Object{"session_id": id})
	baseline := before["review"].(map[string]any)["baseline"]
	beforeJSON, _ := json.Marshal(baseline)
	var doc review.Object
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatal(err)
	}
	doc["revision"] = "r2"
	doc["nodes"].([]any)[0].(map[string]any)["detail"] = "新的实际业务条件"
	body, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, body, 0600); err != nil {
		t.Fatal(err)
	}
	args := review.Object{"session_id": id, "review_file": file, "source_root": root, "base_round": 1, "summary": "更新业务条件"}
	revised := callTool(t, client, "revise_review", args)
	if revised["round"] != float64(2) {
		t.Fatal(revised)
	}
	current := callTool(t, client, "get_review", review.Object{"session_id": id})
	currentJSON, _ := json.Marshal(current["review"].(map[string]any)["baseline"])
	if string(beforeJSON) != string(currentJSON) {
		t.Fatal("revision replaced the fixed baseline")
	}
	stale, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "revise_review", Arguments: args})
	if err != nil || !stale.IsError || !strings.Contains(toolText(stale), "会话已是第 2 轮") {
		t.Fatal(err, toolText(stale))
	}
	if err := os.WriteFile(root+"/logic.ts", []byte("changed()\n"), 0600); err != nil {
		t.Fatal(err)
	}
	staleSource, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "verify_review", Arguments: review.Object{"review_file": file, "source_root": root}})
	if err != nil || !staleSource.IsError || !strings.Contains(toolText(staleSource), "来源文件已变化") {
		t.Fatal(err, toolText(staleSource))
	}
}

func TestMCPActualWaitCancellationAndTimeout(t *testing.T) {
	s := testServer(t)
	started := observeTool(s, "wait_review")
	client := connectMCP(t, s)
	created := createReview(t, s, false)
	id := created["id"].(string)
	ctx, cancel := context.WithCancel(t.Context())
	result := make(chan error, 1)
	go func() {
		_, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "wait_review", Arguments: review.Object{"session_id": id}})
		result <- err
	}()
	awaitStarted(t, started)
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("wait cancellation succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("canceled wait hung")
	}
	second := connectMCP(t, s)
	timedOut, err := second.CallTool(t.Context(), &mcp.CallToolParams{Name: "wait_review", Arguments: review.Object{"session_id": id, "timeout_seconds": 0.03}})
	if err != nil || !timedOut.IsError || !strings.Contains(toolText(timedOut), "超时") {
		t.Fatal(err, toolText(timedOut))
	}
	retained := callTool(t, second, "get_review", review.Object{"session_id": id})
	if retained["phase"] != "awaiting-review" || len(retained["history"].([]any)) != 0 || retained["acknowledgedSubmission"] != nil {
		t.Fatal(retained)
	}
	status, value := requestJSON(t, s, "POST", sessionPrefix+"/"+id+"/finish", review.Object{"expectedVersion": 1, "kind": "approval"}, nil)
	_ = mustObject(t, status, value)
	if callTool(t, second, "wait_review", review.Object{"session_id": id})["approved"] != true {
		t.Fatal("approval lost after cancel")
	}
}

func TestMCPDefaultSDKNegotiatesLegacyProtocol(t *testing.T) {
	s := testServer(t)
	client := mcp.NewClient(&mcp.Implementation{Name: "default-protocol-client", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: s.URL + "/mcp"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	if _, err := session.ListTools(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestTypeScriptMCPCompatibility(t *testing.T) {
	sdkRoot := os.Getenv("LOGIC_MARGIN_SDK_ROOT")
	if sdkRoot == "" {
		sdkRoot, _ = filepath.Abs("../..")
	}
	if _, err := os.Stat(filepath.Join(sdkRoot, "node_modules", "@modelcontextprotocol", "sdk")); err != nil {
		t.Skip("install npm dev dependencies for the official MCP SDK client check")
	}
	s := testServer(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "node", "testdata/mcp-compat.mjs", sdkRoot, s.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("TS MCP compatibility: %v\n%s", err, output)
	}
	t.Log(strings.TrimSpace(string(output)))
}

func TestMCPDeleteAbortsAllPendingCalls(t *testing.T) {
	s := testServer(t)
	started := make(chan struct{}, 2)
	s.mcp.AddTool(&mcp.Tool{Name: "test_wait", InputSchema: review.Object{"type": "object"}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		started <- struct{}{}
		<-ctx.Done()
		return toolError(ctx.Err().Error()), nil
	})
	client := connectMCP(t, s)
	results := make(chan bool, 2)
	for i := 0; i < 2; i++ {
		go func() {
			result, err := client.CallTool(t.Context(), &mcp.CallToolParams{Name: "test_wait", Arguments: review.Object{}})
			results <- err != nil || result.IsError
		}()
	}
	awaitStarted(t, started)
	awaitStarted(t, started)
	status, _ := requestJSON(t, s, "DELETE", "/mcp", nil, map[string]string{"Mcp-Session-Id": client.ID()})
	if status != 200 {
		t.Fatal("DELETE must retain the TS 200 status", status)
	}
	for i := 0; i < 2; i++ {
		select {
		case failed := <-results:
			if !failed {
				t.Fatal("deleted session completed a pending tool")
			}
		case <-time.After(time.Second):
			t.Fatal("DELETE left a pending handler")
		}
	}
}

func TestMCPIdleTimerWaitsForAllHTTPResponses(t *testing.T) {
	s := testServer(t)
	client := mcp.NewClient(&mcp.Implementation{Name: "idle-test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: s.URL + "/mcp", DisableStandaloneSSE: true}, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	first, ok := s.beginMCPRequest(session.ID())
	if !ok {
		t.Fatal("session closed before activity")
	}
	second, ok := s.beginMCPRequest(session.ID())
	if !ok || first != second {
		t.Fatal("session activity was not shared")
	}
	s.endMCPRequest(session.ID(), first, time.Millisecond)
	s.mu.Lock()
	hasTimer := first.idle != nil
	s.mu.Unlock()
	if hasTimer {
		t.Fatal("an open HTTP response must prevent idle expiration")
	}
	s.endMCPRequest(session.ID(), second, time.Millisecond)
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for s.mcpSession(session.ID()) != nil {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("idle session was not disposed")
		}
	}
}

func TestMCPCatalogMatchesFrozenLegacyContract(t *testing.T) {
	s := testServer(t)
	client := connectMCP(t, s)
	catalog, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	actual := []any{}
	for _, tool := range catalog.Tools {
		raw, err := json.Marshal(tool)
		if err != nil {
			t.Fatal(err)
		}
		var shape map[string]any
		if err := json.Unmarshal(raw, &shape); err != nil {
			t.Fatal(err)
		}
		entry := map[string]any{}
		for _, key := range []string{"name", "description", "inputSchema", "annotations"} {
			if value, ok := shape[key]; ok {
				entry[key] = value
			}
		}
		actual = append(actual, entry)
	}
	sort.Slice(actual, func(i, j int) bool {
		return actual[i].(map[string]any)["name"].(string) < actual[j].(map[string]any)["name"].(string)
	})
	raw, err := os.ReadFile("testdata/mcp-catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected []any
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("Go MCP catalog diverged from the fixed 13e5150 Node contract")
	}
}
