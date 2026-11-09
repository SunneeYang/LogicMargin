package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"logicmargin/internal/review"
)

const maxBodyBytes = 11 * 1024 * 1024
const sessionPrefix = "/api/review-sessions"

var sessionRoute = regexp.MustCompile(`^/api/review-sessions/([^/]+)(?:/(mutations|finish|ack|revise|cleanup|restore|archive|baseline)|/(snapshots|records)/([^/]+))?$`)

func trimJS(value string) string {
	return strings.Trim(value, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

func apiError(message string, status int) error {
	return &review.Error{Message: message, Status: status}
}

func readJSON(r *http.Request, mcpRequest bool) ([]byte, error) {
	prefix := ""
	if mcpRequest {
		prefix = "MCP "
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, apiError(prefix+"请求需要 application/json", 415)
	}
	if r.ContentLength > maxBodyBytes {
		return nil, apiError(prefix+"请求超过 11 MB 上限", 413)
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if len(body) > maxBodyBytes {
		return nil, apiError(prefix+"请求超过 11 MB 上限", 413)
	}
	if err != nil || !json.Valid(body) {
		return nil, apiError(prefix+"请求 JSON 无效", 400)
	}
	if err := review.CheckJSONUnicode(body); err != nil {
		return nil, apiError(err.Error(), 400)
	}
	return body, nil
}

// Number also accepts the whitespace and radix forms accepted by JavaScript.
func jsNumber(value string) float64 {
	value = trimJS(value)
	if value == "" {
		return 0
	}
	if len(value) > 2 && value[0] == '0' && strings.ContainsAny(value[1:2], "xXoObB") {
		parsed, err := strconv.ParseUint(value, 0, 64)
		if err == nil {
			return float64(parsed)
		}
		return math.NaN()
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || strings.Contains(value, "_") || strings.ContainsAny(value, "pP") {
		return math.NaN()
	}
	return parsed
}

func safePositiveInteger(value float64) bool {
	return value >= 1 && value <= 9007199254740991 && math.Trunc(value) == value
}

func (s *Server) sessionAPI(r *http.Request) (any, int, error) {
	rawPath := strings.SplitN(r.RequestURI, "?", 2)[0]
	fail := func(message string, status int) (any, int, error) { return nil, status, apiError(message, status) }
	if rawPath != sessionPrefix && !strings.HasPrefix(rawPath, sessionPrefix+"/") {
		return fail("找不到此审查接口", 404)
	}
	query := r.URL.Query()
	view := ""
	if query.Get("view") == "current" {
		view = "current"
	}
	if r.Method == http.MethodPost && !sameOrigin(r) {
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			return fail("拒绝跨站会话写入", 403)
		}
		return fail("拒绝跨域会话写入", 403)
	}
	readValue := func() (any, error) {
		body, err := readJSON(r, false)
		if err != nil {
			return nil, err
		}
		var value any
		err = json.Unmarshal(body, &value)
		return value, err
	}
	if rawPath == sessionPrefix && r.Method == http.MethodPost {
		value, err := readValue()
		if err != nil {
			return nil, 0, err
		}
		input, ok := value.(map[string]any)
		if !ok {
			return fail("缺少评审流程", 400)
		}
		document, ok := input["review"]
		if !ok {
			return fail("缺少评审流程", 400)
		}
		options := review.Object{}
		for _, key := range []string{"scope", "cleanupPolicy", "baselineReview"} {
			if value, present := input[key]; present {
				options[key] = value
			}
		}
		result, err := s.store.Create(document, view, options)
		return result, 201, err
	}
	if rawPath == sessionPrefix && r.Method == http.MethodGet {
		options := review.Object{}
		for _, key := range []string{"context", "state"} {
			if query.Has(key) {
				options[key] = query.Get(key)
			}
		}
		result, err := s.store.List(options)
		return result, 200, err
	}
	match := sessionRoute.FindStringSubmatch(rawPath)
	if match == nil {
		return fail("找不到此审查接口", 404)
	}
	id, action, resource, resourceID := match[1], match[2], match[3], match[4]
	if action == "baseline" && r.Method == http.MethodGet {
		result, err := s.store.GetBaseline(id)
		return result, 200, err
	}
	if action == "archive" {
		if r.Method != http.MethodGet {
			return fail("此接口仅支持读取", 405)
		}
		result, err := s.store.GetArchive(id)
		return result, 200, err
	}
	if resource != "" {
		if r.Method != http.MethodGet {
			return fail("此接口仅支持读取", 405)
		}
		if resource == "snapshots" {
			round := jsNumber(resourceID)
			if !safePositiveInteger(round) {
				return fail("轮次无效", 400)
			}
			result, err := s.store.GetSnapshot(id, int(round))
			return result, 200, err
		}
		record, err := url.PathUnescape(resourceID)
		if err != nil {
			return nil, 0, err
		}
		result, err := s.store.GetRecord(id, record)
		return result, 200, err
	}
	if action == "" && r.Method == http.MethodGet {
		if !query.Has("afterVersion") {
			result, err := s.store.Get(id, view)
			return result, 200, err
		}
		afterVersion := jsNumber(query.Get("afterVersion"))
		waitMS := 25000.0
		if query.Has("waitMs") {
			waitMS = jsNumber(query.Get("waitMs"))
		}
		if !safePositiveInteger(afterVersion) || math.IsNaN(waitMS) || math.IsInf(waitMS, 0) || waitMS < 0 {
			return fail("等待参数无效", 400)
		}
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(s.ctx, cancel)
		defer stop()
		defer cancel()
		result, err := s.store.WaitForChange(ctx, id, int(afterVersion), time.Duration(math.Min(waitMS, 25000)*float64(time.Millisecond)), view)
		if s.ctx.Err() != nil {
			return fail("服务正在停止，请恢复会话后重试", 503)
		}
		if errors.Is(err, context.Canceled) {
			return nil, 0, err
		}
		if result == nil && err == nil {
			return nil, 204, nil
		}
		return result, 200, err
	}
	if action != "" && r.Method == http.MethodPost {
		value, err := readValue()
		if err != nil {
			return nil, 0, err
		}
		var result review.Object
		switch action {
		case "cleanup":
			result, err = s.store.Cleanup(id, value)
		case "restore":
			result, err = s.store.Restore(id, value)
		case "baseline":
			result, err = s.store.AttachBaseline(id, value, view)
		case "mutations":
			result, err = s.store.Mutate(id, value, view)
		case "finish":
			result, err = s.store.Finish(id, value, view)
		case "ack":
			result, err = s.store.Acknowledge(id, value, view)
		default:
			result, err = s.store.Revise(id, value, view)
		}
		return result, 200, err
	}
	return fail("此接口不支持该方法", 405)
}
