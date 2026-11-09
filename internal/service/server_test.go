package service

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"logicmargin/internal/review"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	s, err := Start(Options{Assets: fstest.MapFS{
		"index.html":        &fstest.MapFile{Data: []byte("<!doctype html><title>LogicMargin</title>")},
		"assets/app-abc.js": &fstest.MapFile{Data: []byte(strings.Repeat(`console.log("packaged UI");`, 1000))},
	}, DataDir: t.TempDir(), InstanceID: "service-test", Version: "0.8.7", ShutdownToken: "only-owner-can-stop"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func TestCloseDropsConnectionsWithoutRequests(t *testing.T) {
	s := testServer(t)
	connection, err := net.DialTimeout("tcp", strings.TrimPrefix(s.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		accepted := len(s.newConnections) != 0
		s.mu.Unlock()
		if accepted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("TCP connection was not accepted")
		}
		time.Sleep(time.Millisecond)
	}
	start := time.Now()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("unused TCP connection delayed shutdown")
	}
}

func fixtureReview() review.Object {
	return review.Object{
		"schemaVersion": 1, "id": "service-fixture", "title": "独立评审 😀", "description": "<>&", "revision": "r1",
		"snapshot": review.Object{"repository": "fixture", "commit": "fixed", "fingerprint": "fixed", "capturedAt": "2026-11-08T00:00:00Z", "dirty": false},
		"coverage": review.Object{"included": []any{}, "excluded": []any{}, "note": ""},
		"scenes":   []any{review.Object{"id": "main", "title": "主流程", "description": ""}},
		"nodes":    []any{review.Object{"id": "entry", "sceneId": "main", "title": "入口", "kind": "action", "summary": "", "detail": "", "input": "", "output": "", "position": review.Object{"x": 0, "y": 0}, "evidence": []any{}}},
		"edges":    []any{}, "comments": []any{},
	}
}

func requestJSON(t *testing.T, s *Server, method, path string, value any, headers map[string]string) (int, any) {
	t.Helper()
	var body io.Reader
	if value != nil {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	r, err := http.NewRequestWithContext(t.Context(), method, s.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if len(data) != 0 {
		if err = json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("%s %s: %d %s: %v", method, path, response.StatusCode, data, err)
		}
	}
	return response.StatusCode, decoded
}

func mustObject(t *testing.T, status int, value any) review.Object {
	t.Helper()
	object, ok := value.(map[string]any)
	if status < 200 || status >= 300 || !ok {
		t.Fatalf("status=%d value=%v", status, value)
	}
	return object
}

func createReview(t *testing.T, s *Server, current bool) review.Object {
	t.Helper()
	path := sessionPrefix
	if current {
		path += "?view=current"
	}
	status, value := requestJSON(t, s, "POST", path, review.Object{"review": fixtureReview()}, map[string]string{"Origin": s.URL})
	if status != 201 {
		t.Fatalf("create: %d %v", status, value)
	}
	return mustObject(t, status, value)
}

func TestStaticAssetsHealthAndPaths(t *testing.T) {
	s := testServer(t)
	for _, item := range []struct {
		path, encoding, method string
		status                 int
	}{
		{"/", "", "GET", 200}, {"/review/current", "", "GET", 200}, {"/assets/app-abc.js", "gzip", "GET", 200},
		{"/review/history.js/", "", "GET", 200}, {"/%ff", "", "GET", 400},
		{"/assets/app-abc.js", "gzip", "HEAD", 200}, {"/assets/app-abc.js", "identity", "GET", 200},
		{"/assets/app-abc.js", "*;q=0", "GET", 406}, {"/package.json", "", "GET", 404}, {"/assets/missing.js", "", "GET", 404},
		{"/api/missing", "", "GET", 404}, {"/%2e%2e%2fpackage.json", "", "GET", 400}, {"/%5cpackage.json", "", "GET", 400},
		{"//outside", "", "GET", 400}, {"/%00", "", "GET", 400}, {"/", "", "POST", 405}, {"/api/health", "", "HEAD", 200},
	} {
		r, err := http.NewRequestWithContext(t.Context(), item.method, s.URL+item.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Accept-Encoding", item.encoding)
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != item.status {
			t.Fatalf("%+v: %d %s %v", item, response.StatusCode, body, err)
		}
		if item.method == "HEAD" && (len(body) != 0 || response.Header.Get("Content-Length") == "0") {
			t.Fatal("invalid HEAD", response.Header)
		}
		if response.Header.Get("Content-Encoding") == "gzip" && item.method == "GET" {
			reader, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			plain, err := io.ReadAll(reader)
			_ = reader.Close()
			if err != nil || !strings.Contains(string(plain), "packaged UI") {
				t.Fatal("bad gzip", err)
			}
		}
		if item.status == 200 && strings.HasPrefix(item.path, "/assets/") && !strings.Contains(response.Header.Get("Cache-Control"), "immutable") {
			t.Fatal(response.Header)
		}
	}
	status, value := requestJSON(t, s, "GET", "/api/health", nil, nil)
	health := mustObject(t, status, value)
	if health["service"] != "logic-margin" || health["apiVersion"] != float64(1) || health["pid"] != float64(os.Getpid()) || health["managed"] != true || health["mcp"] != true || health["instanceId"] != "service-test" {
		t.Fatal(health)
	}
	for _, options := range []Options{{}, {Version: "x", InstanceID: "x", ShutdownToken: "x"}, {Version: "x", InstanceID: "x", ShutdownToken: "x", Assets: fstest.MapFS{}}} {
		if unexpected, err := Start(options); err == nil {
			_ = unexpected.Close()
			t.Fatal("accepted invalid startup")
		}
	}
}

func TestAPIOriginBodyAndMethods(t *testing.T) {
	s := testServer(t)
	for _, headers := range []map[string]string{{"Origin": "https://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}} {
		status, _ := requestJSON(t, s, "POST", sessionPrefix, review.Object{"review": fixtureReview()}, headers)
		if status != 403 {
			t.Fatal(status)
		}
	}
	for _, item := range []struct {
		path, method, body, mediaType string
		want                          int
	}{
		{sessionPrefix, "POST", "{}", "text/plain", 415}, {sessionPrefix, "POST", "{invalid", "application/json", 400},
		{sessionPrefix, "POST", "[]", "application/json", 400}, {sessionPrefix, "PUT", "", "", 404},
		{sessionPrefix + "/id/archive", "POST", "{}", "application/json", 405}, {sessionPrefix + "/id/records/x", "POST", "{}", "application/json", 405},
		{sessionPrefix + "/id?afterVersion=0", "GET", "", "", 400}, {sessionPrefix + "/id?afterVersion=1.5", "GET", "", "", 400},
		{sessionPrefix + "/id?afterVersion=1&waitMs=Infinity", "GET", "", "", 400}, {sessionPrefix + "/id/snapshots/1.5", "GET", "", "", 400},
	} {
		r := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
		r.Header.Set("Content-Type", item.mediaType)
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		if w.Code != item.want {
			t.Fatalf("%+v: %d %s", item, w.Code, w.Body.String())
		}
	}
	for _, declared := range []bool{false, true} {
		r := httptest.NewRequest("POST", sessionPrefix, strings.NewReader(strings.Repeat("x", maxBodyBytes+1)))
		if !declared {
			r.ContentLength = -1
		}
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.serveHTTP(w, r)
		if w.Code != 413 || !strings.Contains(w.Body.String(), "11 MB") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestAPISubmissionViewsAndShutdown(t *testing.T) {
	s := testServer(t)
	created := createReview(t, s, true)
	id := created["id"].(string)
	path := sessionPrefix + "/" + id
	if created["view"] != "current" {
		t.Fatal(created)
	}
	status, value := requestJSON(t, s, "GET", sessionPrefix, nil, nil)
	if len(mustObject(t, status, value)["sessions"].([]any)) != 1 {
		t.Fatal(value)
	}
	status, value = requestJSON(t, s, "GET", path+"/snapshots/1", nil, nil)
	if mustObject(t, status, value)["review"] == nil {
		t.Fatal(value)
	}
	status, _ = requestJSON(t, s, "GET", path+"?afterVersion=1&waitMs=1", nil, nil)
	if status != 204 {
		t.Fatal(status)
	}
	comment := review.Object{"id": "human-comment", "body": "请核对失败出口", "targets": []any{review.Object{"kind": "node", "id": "entry"}}, "status": "open", "createdAt": "2026-11-08T00:00:00Z", "revision": "r1"}
	status, value = requestJSON(t, s, "POST", path+"/mutations?view=current", review.Object{"round": 1, "revision": "r1", "fingerprint": "fixed", "mutations": []any{review.Object{"kind": "add-comment", "comment": comment}}}, nil)
	saved := mustObject(t, status, value)
	status, value = requestJSON(t, s, "POST", path+"/finish?view=current", review.Object{"expectedVersion": saved["version"], "kind": "feedback"}, nil)
	finished := mustObject(t, status, value)
	if finished["phase"] != "feedback-ready" {
		t.Fatal(finished)
	}
	recordID := finished["history"].([]any)[0].(map[string]any)["id"].(string)
	status, value = requestJSON(t, s, "GET", path+"/records/"+recordID, nil, nil)
	if mustObject(t, status, value)["review"] == nil {
		t.Fatal(value)
	}
	status, value = requestJSON(t, s, "POST", path+"/ack", review.Object{"submissionId": recordID}, nil)
	acknowledged := mustObject(t, status, value)
	if acknowledged["phase"] != "agent-working" {
		t.Fatal(acknowledged)
	}
	for _, item := range []struct {
		method  string
		headers map[string]string
		want    int
	}{
		{"GET", nil, 405}, {"POST", nil, 403}, {"POST", map[string]string{"X-Logic-Margin-Token": "only-owner-can-stop", "Origin": "https://evil.example"}, 403},
		{"POST", map[string]string{"X-Logic-Margin-Token": "only-owner-can-stop", "Sec-Fetch-Site": "cross-site"}, 403},
	} {
		status, _ := requestJSON(t, s, item.method, "/api/shutdown", nil, item.headers)
		if status != item.want {
			t.Fatal(status, item.want)
		}
	}
	pollResult := make(chan int, 1)
	go func() {
		r := httptest.NewRequest("GET", path+"?afterVersion="+strconv.Itoa(int(acknowledged["version"].(float64)))+"&waitMs=25000", nil)
		response := httptest.NewRecorder()
		s.serveHTTP(response, r)
		pollResult <- response.Code
	}()
	status, value = requestJSON(t, s, "POST", "/api/shutdown", nil, map[string]string{"X-Logic-Margin-Token": "only-owner-can-stop", "Origin": s.URL})
	if status != 200 || value.(map[string]any)["stopped"] != true {
		t.Fatal(status, value)
	}
	select {
	case <-s.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown hung")
	}
	select {
	case status := <-pollResult:
		if status != 503 {
			t.Fatalf("shutdown poll status=%d", status)
		}
	case <-time.After(time.Second):
		t.Fatal("orphan poll")
	}
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Go(func() {
			if err := s.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
}

func sourceFixture(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	source := "check()\nrun()\n"
	digest := sha256.Sum256([]byte(source))
	files := []review.Object{{"path": "logic.ts", "sha256": hex.EncodeToString(digest[:])}}
	manifest := `[{"path":"logic.ts","sha256":"` + hex.EncodeToString(digest[:]) + `"}]`
	fingerprint := sha256.Sum256([]byte(manifest))
	doc := fixtureReview()
	doc["snapshot"].(review.Object)["files"] = files
	doc["snapshot"].(review.Object)["fingerprint"] = hex.EncodeToString(fingerprint[:])
	body, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"review.json": body, "logic.ts": []byte(source)} {
		if err := os.WriteFile(directory+"/"+name, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return directory + "/review.json", directory
}

func TestCanceledHTTPPoll(t *testing.T) {
	s := testServer(t)
	created := createReview(t, s, false)
	ctx, cancel := context.WithCancel(t.Context())
	request, _ := http.NewRequestWithContext(ctx, "GET", s.URL+sessionPrefix+"/"+created["id"].(string)+"?afterVersion=1&waitMs=25000", nil)
	result := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- err
	}()
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("canceled poll succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation hung")
	}
	status, _ := requestJSON(t, s, "GET", "/api/health", nil, nil)
	if status != 200 {
		t.Fatal(status)
	}
}
