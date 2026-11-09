package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"logicmargin/internal/sourcecontext"
)

const maxContextResponseBytes = 64 * 1024

type contextUpload struct {
	snapshot    object
	fingerprint string
	sources     []sourcecontext.Source
}

// This separate client never inherits proxies, redirect behavior or transports
// from the ordinary session client; full source may only reach a loopback peer.
func sourceContextClient(base string) *http.Client {
	u, err := url.Parse(base)
	if err != nil || !contains(u.Scheme, "http", "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil
	}
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		DisableCompression: true, MaxConnsPerHost: 2,
		ResponseHeaderTimeout: 2 * time.Second, TLSHandshakeTimeout: 2 * time.Second,
		MaxResponseHeaderBytes: 8192,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			peer, ok := conn.RemoteAddr().(*net.TCPAddr)
			if !ok || !peer.IP.IsLoopback() {
				conn.Close()
				return nil, errors.New("source context peer is not loopback")
			}
			return conn, nil
		},
	}
	return &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func contextRequest(ctx context.Context, client *http.Client, method, endpoint string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := jsonBytes(body)
		if err != nil {
			return nil, err
		}
		if len(raw) > 11*1024*1024 {
			return nil, errors.New("source context request exceeds upload limit")
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("source context request failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxContextResponseBytes+1))
	if err != nil || len(raw) > maxContextResponseBytes {
		return nil, errors.New("invalid source context response")
	}
	return raw, nil
}

func uploadSourceContexts(ctx context.Context, base, sessionID string, uploads []contextUpload) object {
	if len(uploads) == 0 {
		return nil
	}
	client := sourceContextClient(base)
	if client == nil {
		return nil
	}
	defer client.CloseIdleConnections()
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	raw, err := contextRequest(probeCtx, client, http.MethodGet, base+"/api/precompute", nil)
	cancel()
	var capability struct {
		Version int `json:"sourceContextVersion"`
	}
	if err != nil || json.Unmarshal(raw, &capability) != nil || capability.Version != 1 {
		return nil
	}
	endpoint := base + "/api/review-sessions/" + encodeURIComponent(sessionID) + "/source-contexts"
	uploaded, failed := 0, 0
	for _, upload := range uploads {
		results := make([]error, len(upload.sources))
		jobs := make(chan int)
		var workers sync.WaitGroup
		for worker := 0; worker < min(2, len(upload.sources)); worker++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for i := range jobs {
					_, results[i] = contextRequest(ctx, client, http.MethodPost, endpoint, object{
						"snapshot": upload.snapshot, "fingerprint": upload.fingerprint,
						"sources": []sourcecontext.Source{upload.sources[i]},
					})
				}
			}()
		}
		for i := range upload.sources {
			jobs <- i
		}
		close(jobs)
		workers.Wait()
		for _, err := range results {
			if err != nil {
				failed++
			} else {
				uploaded++
			}
		}
		_, err := contextRequest(ctx, client, http.MethodPost, endpoint, object{
			"snapshot": upload.snapshot, "fingerprint": upload.fingerprint,
			"sources": []sourcecontext.Source{}, "warm": true,
		})
		if err != nil {
			failed++
		}
	}
	if failed > 0 {
		// Never echo server bodies or request errors, which could contain source.
		return object{"status": "partial", "uploaded": uploaded, "failed": failed, "error": "分析源码缓存上传未全部完成；评审发布已成功"}
	}
	return object{"status": "uploaded", "uploaded": uploaded}
}

func publishedSourceContexts(ctx context.Context, base, command string, current, prepared, baseline object, sources, baselineSources []sourcecontext.Source, baselineReview bool) object {
	var uploads []contextUpload
	if contains(command, "start", "revise") && len(sources) > 0 {
		uploads = append(uploads, contextUpload{object{"kind": "round", "round": current["round"]}, str(obj(prepared["snapshot"])["fingerprint"]), sources})
	}
	if command == "start" && baselineReview {
		baseline, baselineSources = prepared, sources
	}
	if contains(command, "start", "baseline") && len(baselineSources) > 0 {
		uploads = append(uploads, contextUpload{object{"kind": "baseline"}, str(obj(baseline["snapshot"])["fingerprint"]), baselineSources})
	}
	return uploadSourceContexts(ctx, base, str(current["id"]), uploads)
}
