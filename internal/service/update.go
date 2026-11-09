package service

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"logicmargin/internal/review"
	"logicmargin/internal/update"
)

func newUpdateToken() string { return rand.Text() }
func localManagementRequest(r *http.Request) bool {
	if !localMCPRequest(r) {
		return false
	}
	for name := range r.Header {
		if strings.EqualFold(name, "Forwarded") || strings.EqualFold(name, "X-Real-IP") || strings.HasPrefix(strings.ToLower(name), "x-forwarded-") {
			return false
		}
	}
	return true
}
func (s *Server) serveUpdate(w http.ResponseWriter, r *http.Request, pathname string) bool {
	if pathname != "/api/runtime" && pathname != "/api/releases/latest" && !strings.HasPrefix(pathname, "/api/update/") {
		return false
	}
	local := localManagementRequest(r)
	if pathname == "/api/runtime" {
		if r.Method != "GET" {
			sendJSON(w, r, 405, review.Object{"error": "method_not_allowed"})
			return true
		}
		value := review.Object{"version": s.opts.Version, "local": local, "canUpdate": local && s.opts.Home != "" && update.CodexAvailable(), "host": "codex"}
		if local {
			value["csrfToken"] = s.updateToken
		}
		sendJSON(w, r, 200, value)
		return true
	}
	if pathname == "/api/releases/latest" {
		if r.Method != "GET" {
			sendJSON(w, r, 405, review.Object{"error": "method_not_allowed"})
			return true
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		value, err := update.Check(ctx, s.opts.Version)
		if err != nil {
			sendJSON(w, r, 502, review.Object{"error": err.Error()})
		} else {
			sendJSON(w, r, 200, value)
		}
		return true
	}
	if !local {
		sendJSON(w, r, 403, review.Object{"error": "local_update_only"})
		return true
	}
	if pathname == "/api/update/status" && r.Method == "GET" {
		value, err := s.updater.Status()
		if err != nil {
			sendJSON(w, r, 500, review.Object{"error": "update_status_unavailable"})
		} else {
			sendJSON(w, r, 200, value)
		}
		return true
	}
	if r.Method != "POST" {
		sendJSON(w, r, 405, review.Object{"error": "method_not_allowed"})
		return true
	}
	if r.Header.Get("Origin") == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Logic-Margin-CSRF")), []byte(s.updateToken)) != 1 {
		sendJSON(w, r, 403, review.Object{"error": "update_authorization_required"})
		return true
	}
	if pathname == "/api/update/cancel" {
		if err := s.updater.Cancel(); err != nil {
			sendJSON(w, r, 409, review.Object{"error": err.Error()})
		} else {
			sendJSON(w, r, 202, review.Object{"canceling": true})
		}
		return true
	}
	if pathname != "/api/update/start" {
		sendJSON(w, r, 404, review.Object{"error": "not_found"})
		return true
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendJSON(w, r, 400, review.Object{"error": "invalid_update_request"})
		return true
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	var input struct {
		Version string `json:"version"`
	}
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		sendJSON(w, r, 400, review.Object{"error": "invalid_update_request"})
		return true
	}
	if !update.CodexAvailable() {
		sendJSON(w, r, 409, review.Object{"error": "codex_installation_required"})
		return true
	}
	value, err := s.updater.Start(r.Context(), input.Version)
	if err != nil {
		sendJSON(w, r, 409, review.Object{"error": err.Error()})
	} else {
		sendJSON(w, r, 202, value)
	}
	return true
}
