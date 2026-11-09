package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"logicmargin/internal/review"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const requestContextHeader = "X-Logicmargin-Request-Context"
const shutdownMessage = "LogicMargin 服务正在停止；请用 CLI 检查状态后恢复原评审"

var localHostPattern = regexp.MustCompile(`(?i)^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$`)
var legacyProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"}

type mcpConnection struct {
	ctx     context.Context
	cancel  context.CancelFunc
	active  int
	idle    *time.Timer
	closing bool
}

type mcpResponseWriter struct {
	http.ResponseWriter
	mu      sync.Mutex
	pending map[jsonrpc.ID]bool
	failed  bool
}

func newMCPResponseWriter(w http.ResponseWriter, body []byte) *mcpResponseWriter {
	var requests []struct {
		ID     any
		Method string
	}
	if bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
		_ = json.Unmarshal(body, &requests)
	} else {
		requests = make([]struct {
			ID     any
			Method string
		}, 1)
		_ = json.Unmarshal(body, &requests[0])
	}
	writer := &mcpResponseWriter{ResponseWriter: w, pending: make(map[jsonrpc.ID]bool)}
	for _, request := range requests {
		if request.Method == "" {
			continue
		}
		if id, err := jsonrpc.MakeID(request.ID); err == nil && id.IsValid() {
			writer.pending[id] = true
		}
	}
	return writer
}

func (w *mcpResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *mcpResponseWriter) Write(body []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n, err := w.ResponseWriter.Write(body)
	if err != nil || n != len(body) {
		w.failed = true
		return n, err
	}
	// The pinned SDK writes each complete SSE event in one call; notifications are not replies.
	data := body
	if _, payload, ok := bytes.Cut(body, []byte("\ndata: ")); ok {
		data = payload
	}
	if message, err := jsonrpc.DecodeMessage(bytes.TrimSpace(data)); err == nil {
		if response, ok := message.(*jsonrpc.Response); ok {
			delete(w.pending, response.ID)
		}
	}
	return n, err
}

func (w *mcpResponseWriter) FlushError() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	err := http.NewResponseController(w.ResponseWriter).Flush()
	w.failed = w.failed || err != nil
	return err
}

func (w *mcpResponseWriter) complete() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.pending) == 0 && !w.failed
}

func (s *Server) mcpSession(id string) *mcp.ServerSession {
	for session := range s.mcp.Sessions() {
		if session.ID() == id {
			return session
		}
	}
	return nil
}

func (s *Server) beginMCPRequest(id string) (*mcpConnection, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil, false
	}
	connection := s.mcpConnections[id]
	if connection == nil {
		ctx, cancel := context.WithCancel(s.ctx)
		connection = &mcpConnection{ctx: ctx, cancel: cancel}
		s.mcpConnections[id] = connection
	}
	if connection.closing {
		return nil, false
	}
	if connection.idle != nil {
		connection.idle.Stop()
		connection.idle = nil
	}
	connection.active++
	return connection, true
}

func (s *Server) endMCPRequest(id string, connection *mcpConnection, idleTimeout time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	connection.active--
	if connection.active != 0 {
		return
	}
	if connection.closing || s.closing {
		if s.closing || s.mcpSession(id) == nil {
			delete(s.mcpConnections, id)
		}
		return
	}
	connection.idle = time.AfterFunc(idleTimeout, func() { s.disposeMCPSession(id, connection, true) })
}

func (s *Server) disposeMCPSession(id string, connection *mcpConnection, idleOnly bool) {
	s.mu.Lock()
	if s.mcpConnections[id] != connection || (idleOnly && connection.active != 0) {
		s.mu.Unlock()
		return
	}
	connection.closing = true
	if connection.idle != nil {
		connection.idle.Stop()
		connection.idle = nil
	}
	connection.cancel()
	s.mu.Unlock()
	if session := s.mcpSession(id); session != nil {
		_ = session.Close()
	}
	s.mu.Lock()
	if connection.active == 0 && s.mcpConnections[id] == connection {
		delete(s.mcpConnections, id)
	}
	s.mu.Unlock()
}

func localMCPRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() || !localHostPattern.MatchString(r.Host) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	endpoint, valid := originURL("http://" + r.Host)
	if !valid {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, ok := originURL(origin)
		return ok && parsed.Scheme == endpoint.Scheme && parsed.Host == endpoint.Host
	}
	return true
}

func mcpFailure(w http.ResponseWriter, status int, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(review.Object{"jsonrpc": "2.0", "id": nil, "error": review.Object{"code": code, "message": message}})
}

func (s *Server) configureMCP() {
	s.mcpConnections = map[string]*mcpConnection{}
	// shortcut: SDK v1.8.0 omits 2024-10-07; add verified compatibility if those retired clients are still needed.
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "logic-margin", Version: s.opts.Version}, &mcp.ServerOptions{
		GetSessionID:              func() string { return rand.Text() },
		SupportedProtocolVersions: legacyProtocolVersions[:4],
	})
	s.mcp.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if method != "tools/call" {
				return next(ctx, method, request)
			}
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			stop := context.AfterFunc(s.ctx, cancel)
			defer stop()
			if s.ctx.Err() != nil {
				return nil, &jsonrpc.Error{Code: -32000, Message: shutdownMessage}
			}
			// The SDK detaches legacy HTTP contexts to support resumable streams.
			// This service has no replay store, so a disconnected result is lost.
			if extra := request.GetExtra(); extra != nil {
				if original, ok := s.requests.Load(extra.Header.Get(requestContextHeader)); ok {
					stopHTTP := context.AfterFunc(original.(context.Context), cancel)
					defer stopHTTP()
				} else {
					cancel()
				}
			}
			result, err := next(ctx, method, request)
			if s.ctx.Err() != nil {
				return nil, &jsonrpc.Error{Code: -32000, Message: shutdownMessage}
			}
			return result, err
		}
	})
	registerReviewTools(s.mcp, s.URL)
	s.mcpHTTP = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.mcp }, &mcp.StreamableHTTPOptions{
		MaxRequestBodyBytes: maxBodyBytes, PropagateRequestCancellation: true,
	})
}

func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request) {
	if !localMCPRequest(r) {
		mcpFailure(w, 403, "MCP 仅接受本机同源连接", -32000)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		mcpFailure(w, 405, "MCP 不支持此请求方法", -32000)
		return
	}
	ids := r.Header.Values("Mcp-Session-Id")
	if len(ids) > 1 {
		mcpFailure(w, 400, "MCP 会话标识无效", -32000)
		return
	}
	if len(ids) == 1 {
		if s.mcpSession(ids[0]) == nil {
			mcpFailure(w, 404, "MCP 会话已结束，请重新连接", -32000)
			return
		}
	}
	var message review.Object
	var response *mcpResponseWriter
	if r.Method == http.MethodPost {
		body, err := readJSON(r, true)
		if err != nil {
			var inputError *review.Error
			status, code := 400, -32700
			if errors.As(err, &inputError) {
				status = inputError.Status
				if status != 400 {
					code = -32000
				}
			}
			mcpFailure(w, status, err.Error(), code)
			return
		}
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = json.Unmarshal(body, &message)
		response = newMCPResponseWriter(w, body)
	}
	if len(ids) == 0 && (r.Method != http.MethodPost || message["method"] != "initialize" || message["id"] == nil) {
		mcpFailure(w, 400, "MCP 连接需要先初始化", -32600)
		return
	}
	accept := r.Header.Get("Accept")
	if r.Method == http.MethodPost && (!strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream")) {
		mcpFailure(w, 406, "Not Acceptable: Client must accept both application/json and text/event-stream", -32000)
		return
	}
	if r.Method == http.MethodGet && !strings.Contains(accept, "text/event-stream") {
		mcpFailure(w, 406, "Not Acceptable: Client must accept text/event-stream", -32000)
		return
	}
	if r.Method == http.MethodPost && strings.TrimSpace(strings.SplitN(strings.ToLower(r.Header.Get("Content-Type")), ";", 2)[0]) != "application/json" {
		mcpFailure(w, 415, "Unsupported Media Type: Content-Type must be application/json", -32000)
		return
	}
	if message["method"] == "initialize" {
		if len(ids) > 0 {
			mcpFailure(w, 400, "Invalid Request: Server already initialized", -32600)
			return
		}
		r.Header.Del("Mcp-Protocol-Version")
	} else if versions := r.Header.Values("Mcp-Protocol-Version"); len(versions) > 0 {
		valid := false
		for _, version := range legacyProtocolVersions {
			valid = valid || r.Header.Get("Mcp-Protocol-Version") == version
		}
		if !valid {
			mcpFailure(w, 400, "Bad Request: Unsupported protocol version: "+r.Header.Get("Mcp-Protocol-Version")+" (supported versions: "+strings.Join(legacyProtocolVersions, ", ")+")", -32000)
			return
		}
	}
	if s.ctx.Err() != nil {
		mcpFailure(w, 503, "LogicMargin 服务正在停止", -32000)
		return
	}
	var connection *mcpConnection
	if len(ids) == 1 {
		var ok bool
		connection, ok = s.beginMCPRequest(ids[0])
		if !ok {
			mcpFailure(w, 404, "MCP 会话已结束，请重新连接", -32000)
			return
		}
		defer s.endMCPRequest(ids[0], connection, 10*time.Minute)
		if r.Method == http.MethodDelete {
			s.disposeMCPSession(ids[0], connection, false)
			w.WriteHeader(200)
			return
		}
	}
	token := rand.Text()
	r.Header.Set(requestContextHeader, token)
	ctx := r.Context()
	if connection != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		stop := context.AfterFunc(connection.ctx, cancel)
		defer stop()
		defer cancel()
	}
	s.requests.Store(token, ctx)
	defer s.requests.Delete(token)
	// shortcut: the SDK rejects batches for 2025-06-18+; add verified compatibility if callers need the TS extension.
	if response != nil {
		s.mcpHTTP.ServeHTTP(response, r)
	} else {
		s.mcpHTTP.ServeHTTP(w, r)
	}
	if len(ids) == 0 {
		if id := w.Header().Get("Mcp-Session-Id"); id != "" && s.mcpSession(id) != nil {
			if created, ok := s.beginMCPRequest(id); ok {
				s.endMCPRequest(id, created, 10*time.Minute)
			}
		}
	}
	if r.Method == http.MethodPost && r.Context().Err() != nil && len(ids) == 1 && !response.complete() {
		// Preserve the TS transport's session disposal on a lost POST response.
		s.disposeMCPSession(ids[0], connection, false)
	}
}

func toolError(message string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: message}}}
}
