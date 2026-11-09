package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
	"logicmargin/internal/update"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Options struct {
	Assets        fs.FS
	DataDir       string
	Host          string
	Port          int
	InstanceID    string
	Version       string
	ShutdownToken string
	Home          string
}

type asset struct {
	body, gzip []byte
	mediaType  string
}

type Server struct {
	URL string

	opts           Options
	assets         map[string]asset
	store          *review.Store
	http           *http.Server
	mcp            *mcp.Server
	mcpHTTP        *mcp.StreamableHTTPHandler
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	closing        bool
	newConnections map[net.Conn]struct{}
	posts          sync.WaitGroup
	requests       sync.Map
	mcpConnections map[string]*mcpConnection
	closeOnce      sync.Once
	done           chan struct{}
	closeErr       error
	derived        *precompute.Engine
	contexts       *sourcecontext.Store
	warmMu         sync.Mutex
	warmSeen       map[string]bool
	warmOrder      []string
	warmQueue      chan warmTask
	warmWorkers    sync.WaitGroup
	updater        *update.Manager
	updateToken    string
}

func Start(opts Options) (*Server, error) {
	if opts.ShutdownToken == "" || opts.InstanceID == "" || opts.Version == "" {
		return nil, errors.New("服务身份与关闭令牌不能为空")
	}
	assets := map[string]asset{}
	if opts.Assets == nil {
		return nil, errors.New("程序未包含网页入口，请重新打包")
	}
	err := fs.WalkDir(opts.Assets, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		body, err := fs.ReadFile(opts.Assets, name)
		if err != nil {
			return err
		}
		compressed, err := gzipBytes(body)
		if err != nil {
			return err
		}
		mediaType := mime.TypeByExtension(path.Ext(name))
		if mediaType == "" {
			mediaType = http.DetectContentType(body)
		}
		assets["/"+name] = asset{body, compressed, mediaType}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if _, ok := assets["/index.html"]; !ok {
		return nil, errors.New("程序未包含网页入口，请重新打包")
	}
	host := opts.Host
	if host == "" {
		host = "127.0.0.1"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(opts.Port)))
	if err != nil {
		return nil, err
	}
	publicHost := host
	if host == "0.0.0.0" || host == "::" {
		publicHost = "127.0.0.1"
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{opts: opts, assets: assets, store: review.NewStore(opts.DataDir), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	s.updater = &update.Manager{Home: opts.Home, DataDir: opts.DataDir, InstanceID: opts.InstanceID, Version: opts.Version}
	s.updateToken = newUpdateToken()
	s.newConnections = make(map[net.Conn]struct{})
	derivedDir := opts.DataDir
	if derivedDir == "" {
		derivedDir = filepath.Join(".logic-margin", "sessions")
	}
	s.derived = precompute.NewEngine(filepath.Join(derivedDir, "derived"))
	s.contexts = sourcecontext.NewStore(filepath.Join(derivedDir, "derived", "source-contexts", "v1"))
	s.warmSeen = map[string]bool{}
	s.warmQueue = make(chan warmTask, 16)
	s.warmWorkers.Add(1)
	go s.warmWorker()
	s.URL = "http://" + net.JoinHostPort(publicHost, fmt.Sprint(listener.Addr().(*net.TCPAddr).Port))
	s.configureMCP()
	s.http = &http.Server{Handler: http.HandlerFunc(s.serveHTTP), ReadHeaderTimeout: 10 * time.Second,
		ConnState: func(connection net.Conn, state http.ConnState) {
			s.mu.Lock()
			if state == http.StateNew && !s.closing {
				s.newConnections[connection] = struct{}{}
			} else {
				delete(s.newConnections, connection)
			}
			closeNew := state == http.StateNew && s.closing
			s.mu.Unlock()
			if closeNew {
				_ = connection.Close()
			}
		},
	}
	go func() {
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = s.Close()
		}
	}()
	return s, nil
}

func (s *Server) Done() <-chan struct{} { return s.done }

func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closing = true
		newConnections := make([]net.Conn, 0, len(s.newConnections))
		for connection := range s.newConnections {
			newConnections = append(newConnections, connection)
		}
		s.newConnections = nil
		for _, connection := range s.mcpConnections {
			if connection.idle != nil {
				connection.idle.Stop()
			}
		}
		s.mu.Unlock()
		// Shutdown otherwise gives unstarted HTTP connections a 5s grace, consuming our entire deadline.
		for _, connection := range newConnections {
			_ = connection.Close()
		}
		s.cancel()
		s.store.Close()
		s.derived.Close()
		s.warmWorkers.Wait()
		// Let RPC errors reach waiting clients before closing their SSE streams.
		mcpClosed := make(chan struct{})
		go func() {
			s.posts.Wait()
			for session := range s.mcp.Sessions() {
				_ = session.Close()
			}
			close(mcpClosed)
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.closeErr = s.http.Shutdown(ctx)
		if s.closeErr != nil {
			_ = s.http.Close()
		}
		<-mcpClosed
		close(s.done)
	})
	return s.closeErr
}

func requestPath(r *http.Request) (string, error) {
	raw := strings.SplitN(r.RequestURI, "?", 2)[0]
	decoded, err := url.PathUnescape(raw)
	if err != nil || !utf8.ValidString(decoded) || !strings.HasPrefix(decoded, "/") || strings.HasPrefix(decoded, "//") {
		return "", errors.New("请求路径无效")
	}
	for _, char := range decoded {
		if char == '\\' || char <= 31 || char == 127 {
			return "", errors.New("请求路径无效")
		}
	}
	for part := range strings.SplitSeq(decoded, "/") {
		if part == "." || part == ".." {
			return "", errors.New("请求路径无效")
		}
	}
	return decoded, nil
}

func originURL(raw string) (*url.URL, bool) {
	parsed, err := url.Parse(trimJS(raw))
	if err != nil {
		return nil, false
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Opaque != "" {
		return nil, false
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number > 65535 {
			return nil, false
		}
		parsed.Host = net.JoinHostPort(parsed.Hostname(), strconv.Itoa(number))
	}
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Host = strings.TrimSuffix(parsed.Host, ":")
	if (parsed.Scheme == "http" && parsed.Port() == "80") || (parsed.Scheme == "https" && parsed.Port() == "443") {
		parsed.Host = parsed.Hostname()
		if strings.Contains(parsed.Host, ":") {
			parsed.Host = "[" + parsed.Host + "]"
		}
	}
	return parsed, true
}

func sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, ok := originURL(origin)
		return ok && parsed.Host == r.Host
	}
	return true
}

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	closing := s.closing
	if !closing && r.Method == http.MethodPost {
		s.posts.Add(1)
		defer s.posts.Done()
	}
	s.mu.Unlock()
	if closing {
		sendJSON(w, r, 503, review.Object{"error": "LogicMargin 正在停止，请用 CLI 检查服务后重新连接 MCP"})
		return
	}
	pathname, err := requestPath(r)
	if err != nil {
		sendJSON(w, r, 400, review.Object{"error": "请求路径无效"})
		return
	}
	if s.servePrecompute(w, r, pathname) {
		return
	}
	if s.serveUpdate(w, r, pathname) {
		return
	}
	switch pathname {
	case "/mcp":
		s.serveMCP(w, r)
		return
	case "/api/health":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			sendJSON(w, r, 405, review.Object{"error": "此接口仅支持读取"})
			return
		}
		sendJSON(w, r, 200, review.Object{"service": "logic-margin", "apiVersion": 1, "version": s.opts.Version, "instanceId": s.opts.InstanceID, "pid": os.Getpid(), "managed": true, "mcp": true})
		return
	case "/api/shutdown":
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			sendJSON(w, r, 405, review.Object{"error": "关闭服务需要 POST"})
			return
		}
		if !sameOrigin(r) || r.Header.Get("X-Logic-Margin-Token") != s.opts.ShutdownToken {
			sendJSON(w, r, 403, review.Object{"error": "关闭服务未获授权"})
			return
		}
		w.Header().Set("Connection", "close")
		sendJSON(w, r, 200, review.Object{"stopped": true})
		_ = http.NewResponseController(w).Flush()
		go func() { _ = s.Close() }()
		return
	}
	if pathname == "/api" || strings.HasPrefix(pathname, "/api/") {
		value, status, err := s.sessionAPI(r)
		if err != nil {
			status = 400
			var sessionError *review.Error
			if errors.As(err, &sessionError) && sessionError.Status != 0 {
				status = sessionError.Status
			}
			value = review.Object{"error": err.Error()}
		}
		if status == 204 {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(204)
		} else {
			if err == nil && (r.Method == http.MethodGet || pathname == sessionPrefix || strings.HasSuffix(pathname, "/revise") || strings.HasSuffix(pathname, "/baseline") || strings.HasSuffix(pathname, "/restore")) {
				s.scheduleWarm(value)
			}
			sendJSON(w, r, status, value)
		}
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		sendJSON(w, r, 405, review.Object{"error": "网页仅支持 GET 或 HEAD"})
		return
	}
	name := pathname
	if name == "/" {
		name = "/index.html"
	}
	asset, ok := s.assets[name]
	if !ok && !strings.Contains(pathname[strings.LastIndex(pathname, "/")+1:], ".") {
		asset, ok = s.assets["/index.html"]
	}
	if !ok {
		sendJSON(w, r, 404, review.Object{"error": "找不到此资源"})
		return
	}
	varyEncoding(w.Header())
	encoding := responseEncoding(r.Header.Get("Accept-Encoding"), len(asset.body) >= compressionThreshold)
	if encoding == "" {
		sendJSON(w, r, 406, review.Object{"error": "没有可接受的响应编码"})
		return
	}
	body := asset.body
	if encoding == "gzip" {
		body = asset.gzip
		w.Header().Set("Content-Encoding", "gzip")
	}
	w.Header().Set("Content-Type", asset.mediaType)
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	cache := "no-store"
	if strings.HasPrefix(pathname, "/assets/") {
		cache = "public, max-age=31536000, immutable"
	}
	w.Header().Set("Cache-Control", cache)
	w.WriteHeader(200)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
