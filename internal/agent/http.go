package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"

	"logicmargin/internal/review"
)

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Message) }

type client struct {
	ctx  context.Context
	base string
}

func (c client) payload(path string, body any, timeout time.Duration) (any, error) {
	if err := c.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	method := http.MethodGet
	var data io.Reader
	if body != nil {
		b, err := jsonBytes(body)
		if err != nil {
			return nil, err
		}
		data = bytes.NewReader(b)
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/api/review-sessions"+path, data)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == 204 {
		return nil, nil
	}
	bytes, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		return nil, readErr
	}
	var payload any
	if err := review.CheckJSONUnicode(bytes); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(bytes, &payload)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := http.StatusText(response.StatusCode)
		if v, ok := obj(payload)["error"]; ok {
			message = jsString(v)
		}
		return nil, &HTTPError{response.StatusCode, message}
	}
	return payload, nil
}
func jsString(v any) string {
	if v == nil {
		return "null"
	}
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		return "[object Object]"
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(v)
	}
}
func (c client) request(path string, body any, timeout time.Duration) (object, error) {
	v, err := c.payload(path, body, timeout)
	if err != nil || v == nil {
		return nil, err
	}
	return parseSession(v)
}
func (c client) required(path string, body any) (object, error) {
	result, err := c.request(path, body, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("服务端未返回会话")
	}
	return result, nil
}
func (c client) activeOrArchived(path string) (object, error) {
	result, err := c.required(path, nil)
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == 410 {
		return c.required(path+"/archive", nil)
	}
	return result, err
}
func (c client) cleanup(current object, mode string, force bool) (any, error) {
	body := object{"expectedVersion": current["version"], "mode": mode}
	if force {
		body["allowUnfinished"] = true
	}
	result, err := c.payload("/"+encodeURIComponent(str(current["id"]))+"/cleanup", body, 30*time.Second)
	if err != nil {
		return nil, err
	}
	o := obj(result)
	if o == nil || o["id"] != current["id"] || o["mode"] != mode {
		return nil, errors.New("服务端返回了无效清理结果")
	}
	return result, nil
}
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.!~*'()", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}
func reviewLink(base, id string) string {
	u, _ := url.Parse(base + "/")
	u.RawQuery = url.Values{"session": []string{id}}.Encode()
	return u.String()
}

func parseSession(v any) (object, error) {
	result := obj(v)
	invalid := errors.New("服务端返回了无效会话")
	if result == nil || result["schemaVersion"] != float64(1) || str(result["id"]) == "" || !safeInteger(result["version"]) || number(result["version"]) < 1 || !safeInteger(result["round"]) || number(result["round"]) < 1 || !contains(str(result["phase"]), "awaiting-review", "feedback-ready", "agent-working", "approved") {
		return nil, invalid
	}
	if _, ok := result["snapshots"].([]any); !ok {
		return nil, invalid
	}
	if _, ok := result["createdAt"].(string); !ok {
		return nil, invalid
	}
	if _, ok := result["updatedAt"].(string); !ok {
		return nil, invalid
	}
	if v, ok := result["acknowledgedSubmission"]; ok {
		if _, ok := v.(string); !ok {
			return nil, invalid
		}
	}
	parsed, err := review.ParseReview(result["review"])
	if err != nil {
		return nil, err
	}
	result["review"] = parsed
	history, err := parseHistory(result["history"])
	if err != nil {
		return nil, err
	}
	result["history"] = history
	options, err := review.ParseSessionOptions(result)
	if err != nil {
		return nil, err
	}
	for k, v := range options {
		result[k] = v
	}
	for _, v := range arr(result["snapshots"]) {
		snap := obj(v)
		if snap == nil || !safeInteger(snap["round"]) || number(snap["round"]) < 1 || !validDate(snap["openedAt"]) {
			return nil, errors.New("服务端返回了无效轮次快照")
		}
		if boundary, ok := snap["afterSubmission"]; ok && historyIndex(history, boundary) < 0 {
			return nil, errors.New("服务端返回了无效轮次提交边界")
		}
		parsed, err := review.ParseReview(snap["review"])
		if err != nil {
			return nil, err
		}
		snap["review"] = parsed
	}
	return result, nil
}
func parseHistory(v any) ([]any, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, errors.New("评审历史必须是数组")
	}
	result := []any{}
	byID := map[string]int{}
	for _, raw := range list {
		source := obj(raw)
		if source == nil {
			return nil, errors.New("评审记录必须是对象")
		}
		if source["schemaVersion"] != float64(1) {
			return nil, errors.New("不支持此评审记录版本")
		}
		kind := str(source["kind"])
		if !contains(kind, "logic-margin-feedback", "logic-margin-approval") {
			return nil, errors.New("评审记录类型无效")
		}
		parsed, err := review.ParseReview(source["review"])
		if err != nil {
			return nil, err
		}
		comments := arr(parsed["comments"])
		if kind == "logic-margin-feedback" {
			if len(comments) == 0 {
				return nil, errors.New("意见包只能包含待处理批注，且至少需要一条")
			}
			for _, v := range comments {
				if obj(v)["status"] != "open" {
					return nil, errors.New("意见包只能包含待处理批注，且至少需要一条")
				}
			}
		} else {
			for _, v := range comments {
				if obj(v)["status"] != "resolved" {
					return nil, errors.New("通过记录不能包含未解决的批注")
				}
			}
		}
		id := str(source["id"])
		if trim(id) == "" || utf16Len(id) > 200 {
			return nil, errors.New("评审记录 ID无效，最多 200 字符")
		}
		if !validDate(source["createdAt"]) {
			return nil, errors.New("评审记录日期必须是有效日期")
		}
		record := object{"schemaVersion": float64(1), "kind": kind, "id": id, "createdAt": source["createdAt"], "review": parsed}
		if index, ok := byID[id]; ok {
			if !reflect.DeepEqual(result[index], record) {
				return nil, fmt.Errorf("评审记录 %s 的内容冲突", id)
			}
			result[index] = record
		} else {
			byID[id] = len(result)
			result = append(result, record)
		}
	}
	return result, nil
}
func historyIndex(history []any, id any) int {
	s, ok := id.(string)
	if !ok {
		return -1
	}
	for i, v := range history {
		if obj(v)["id"] == s {
			return i
		}
	}
	return -1
}
