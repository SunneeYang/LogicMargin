package service

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"logicmargin/internal/update"
)

func TestUpdateTrustBoundaryAndRuntimeVersion(t *testing.T) {
	s := &Server{opts: Options{Version: "7.8.9", ShutdownToken: "never-expose-shutdown"}, updateToken: "update-csrf", updater: &update.Manager{}}
	for _, tc := range []struct {
		name, method, path, peer, host, origin, token, forward string
		status                                                 int
	}{
		{"local runtime", "GET", "/api/runtime", "127.0.0.1:1234", "127.0.0.1:9999", "", "", "", 200},
		{"remote runtime", "GET", "/api/runtime", "100.100.1.2:1234", "100.100.1.3:9999", "", "", "", 200},
		{"remote forged host", "POST", "/api/update/start", "100.100.1.2:1234", "127.0.0.1:9999", "http://127.0.0.1:9999", "update-csrf", "", 403},
		{"dns rebinding", "POST", "/api/update/start", "127.0.0.1:1234", "evil.test:9999", "http://evil.test:9999", "update-csrf", "", 403},
		{"cross origin", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "https://evil.test", "update-csrf", "", 403},
		{"wrong scheme", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "https://127.0.0.1:9999", "update-csrf", "", 403},
		{"no origin", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "", "update-csrf", "", 403},
		{"no csrf", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "http://127.0.0.1:9999", "", "", 403},
		{"forwarded", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "http://127.0.0.1:9999", "update-csrf", "100.100.1.2", 403},
		{"remote status", "GET", "/api/update/status", "100.100.1.2:1234", "127.0.0.1:9999", "", "", "", 403},
		{"local status", "GET", "/api/update/status", "127.0.0.1:1234", "127.0.0.1:9999", "", "", "", 200},
		{"arbitrary command", "POST", "/api/update/start", "127.0.0.1:1234", "127.0.0.1:9999", "http://127.0.0.1:9999", "update-csrf", "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, strings.NewReader(`{"version":"9.0.0","command":"touch anything"}`))
			req.RemoteAddr = tc.peer
			req.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.token != "" {
				req.Header.Set("X-Logic-Margin-CSRF", tc.token)
			}
			if tc.forward != "" {
				req.Header.Set("X-Forwarded-For", tc.forward)
			}
			rec := httptest.NewRecorder()
			if !s.serveUpdate(rec, req, tc.path) {
				t.Fatal("not handled")
			}
			if rec.Code != tc.status {
				t.Fatalf("HTTP %d: %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), s.opts.ShutdownToken) {
				t.Fatal("shutdown token exposed")
			}
			if tc.path == "/api/runtime" {
				var v map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &v)
				if v["version"] != "7.8.9" {
					t.Fatal("bundle version used")
				}
				if tc.name == "remote runtime" && v["csrfToken"] != nil {
					t.Fatal("remote token exposed")
				}
			}
		})
	}
}
