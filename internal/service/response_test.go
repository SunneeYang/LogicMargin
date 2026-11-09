package service

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponseEncoding(t *testing.T) {
	for _, test := range []struct {
		header, want string
		large        bool
	}{
		{"", "identity", true}, {"identity", "identity", true}, {"gzip;q=0", "identity", true},
		{"gzip ; q=0", "identity", true}, {"gzip;q=0, *;q=1", "identity", true},
		{"gzip;q=0.5, identity;q=1", "identity", true}, {"gzip;q=invalid", "identity", true},
		{"GZIP", "gzip", true}, {"br, gzip;q=0.8", "gzip", true}, {"*;q=0.5", "gzip", true},
		{"gzip, identity;q=0", "gzip", true}, {"gzip;q=0, identity;q=0", "", true}, {"*;q=0", "", true},
		{"gzip", "identity", false}, {"gzip, identity;q=0", "gzip", false},
		{"gzip;q=0.1234", "identity", true}, {"gzip;q=0,gzip;q=0.8", "gzip", true},
	} {
		if got := responseEncoding(test.header, test.large); got != test.want {
			t.Errorf("%q large=%v: %q, want %q", test.header, test.large, got, test.want)
		}
	}
}

func TestJSONResponse(t *testing.T) {
	value := map[string]any{"message": strings.Repeat("逻辑 <>& 😀\u2028 \\u2028", 300)}
	for _, method := range []string{"GET", "HEAD"} {
		request := httptest.NewRequest(method, "/", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		response := httptest.NewRecorder()
		response.Header().Set("Vary", "Origin")
		sendJSON(response, request, 200, value)
		if response.Header().Get("Vary") != "Origin, Accept-Encoding" || response.Header().Get("Content-Encoding") != "gzip" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal(response.Header())
		}
		if method == "HEAD" {
			if response.Body.Len() != 0 || response.Header().Get("Content-Length") == "0" {
				t.Fatal("HEAD lost representation headers or returned a body")
			}
			continue
		}
		reader, err := gzip.NewReader(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil || strings.Contains(string(body), `\u003c`) || !strings.Contains(string(body), "\u2028") {
			t.Fatalf("JSON gzip/HTML escaping: %s %v", body, err)
		}
		var decoded map[string]any
		if err = json.Unmarshal(body, &decoded); err != nil || decoded["message"] != value["message"] {
			t.Fatalf("JSON changed string: %v", err)
		}
	}
	cycle := map[string]any{}
	cycle["self"] = cycle
	response := httptest.NewRecorder()
	sendJSON(response, httptest.NewRequest("GET", "/", nil), 200, cycle)
	if response.Code != 500 || !strings.Contains(response.Body.String(), "响应序列化失败") {
		t.Fatal(response.Code, response.Body.String())
	}
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("Accept-Encoding", "*;q=0")
	response = httptest.NewRecorder()
	sendJSON(response, request, 200, value)
	if response.Code != 406 || response.Body.Len() != 0 || response.Header().Get("Content-Length") != "0" {
		t.Fatal(response.Code, response.Header(), response.Body.String())
	}
}
