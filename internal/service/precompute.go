package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
)

var computationRoute = regexp.MustCompile(`^/api/review-sessions/([^/]+)/precompute/(diff|structure|layout)$`)

type snapshotSelector struct {
	Kind  string `json:"kind"`
	Round int    `json:"round,omitempty"`
}
type evidenceReference struct {
	Path      string `json:"path"`
	Symbol    string `json:"symbol"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Digest    string `json:"digest"`
}
type diffRequest struct {
	BeforeSnapshot snapshotSelector  `json:"beforeSnapshot"`
	AfterSnapshot  snapshotSelector  `json:"afterSnapshot"`
	Before         evidenceReference `json:"before"`
	After          evidenceReference `json:"after"`
}

func decodeComputation(body []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return apiError("预计算参数无效", 400)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return apiError("预计算参数无效", 400)
	}
	return nil
}

func (s *Server) servePrecompute(w http.ResponseWriter, r *http.Request, pathname string) bool {
	if s.serveSourceContexts(w, r, pathname) {
		return true
	}
	if pathname == "/api/precompute" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			sendJSON(w, r, 405, review.Object{"error": "此接口仅支持读取"})
			return true
		}
		sendJSON(w, r, 200, review.Object{"schemaVersion": 1, "diffAlgorithm": precompute.DiffAlgorithm, "layoutAlgorithm": precompute.LayoutAlgorithm(), "structureAlgorithm": precompute.StructureAlgorithm(), "sourceContextVersion": 1, "coordinate": "utf16"})
		return true
	}
	match := computationRoute.FindStringSubmatch(pathname)
	if match == nil {
		return false
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		sendJSON(w, r, 405, review.Object{"error": "预计算需要 POST"})
		return true
	}
	fail := func(err error) {
		status := 500
		var inputError *review.Error
		if errors.As(err, &inputError) {
			status = inputError.Status
		} else if errors.Is(err, precompute.ErrBusy) || errors.Is(err, precompute.ErrClosed) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			status = 503
		}
		sendJSON(w, r, status, review.Object{"error": err.Error()})
	}
	if !sameOrigin(r) {
		fail(apiError("拒绝跨域会话写入", 403))
		return true
	}
	body, err := readJSON(r, false)
	if err != nil {
		fail(err)
		return true
	}
	id, kind := match[1], match[2]
	// Resolve the owning session before any shared content-cache lookup.
	state, err := s.store.Get(id, "current")
	if err != nil {
		fail(err)
		return true
	}
	var raw json.RawMessage
	var status string
	if kind != "layout" {
		var request diffRequest
		if err = decodeComputation(body, &request); err != nil {
			fail(err)
			return true
		}
		before, err := s.snapshotForComputation(id, state, request.BeforeSnapshot)
		if err != nil {
			fail(err)
			return true
		}
		after, err := s.snapshotForComputation(id, state, request.AfterSnapshot)
		if err != nil {
			fail(err)
			return true
		}
		a, err := sourceForComputation(before, request.Before)
		if err != nil {
			fail(err)
			return true
		}
		b, err := sourceForComputation(after, request.After)
		if err != nil {
			fail(err)
			return true
		}
		if kind == "structure" {
			ac := s.structureSourceContext(r.Context(), id, before, request.Before, a)
			bc := s.structureSourceContext(r.Context(), id, after, request.After, b)
			raw, status, err = s.derived.StructureWithContext(r.Context(), a, b, sourceLanguage(request.After.Path), ac, bc)
		} else {
			raw, status, err = s.derived.Diff(r.Context(), a, b, sourceLanguage(request.After.Path))
		}
	} else {
		var input precompute.LayoutInput
		if err = decodeComputation(body, &input); err != nil {
			fail(err)
			return true
		}
		raw, status, err = s.derived.Layout(r.Context(), input)
	}
	if err != nil {
		fail(err)
		return true
	}
	w.Header().Set("X-Logic-Margin-Cache", status)
	sendJSON(w, r, 200, raw)
	return true
}

func objectForComputation(value any) review.Object { v, _ := value.(map[string]any); return v }
func arrayForComputation(value any) []any {
	switch v := value.(type) {
	case []any:
		return v
	case []review.Object:
		result := make([]any, len(v))
		for i, item := range v {
			result[i] = item
		}
		return result
	}
	return nil
}
func textForComputation(value any) string { v, _ := value.(string); return v }
func integerForComputation(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

func (s *Server) snapshotForComputation(id string, state review.Object, selector snapshotSelector) (review.Object, error) {
	current := objectForComputation(state["review"])
	if selector.Kind == "baseline" && selector.Round == 0 {
		result, err := s.store.GetBaseline(id)
		if err != nil {
			return nil, err
		}
		return objectForComputation(result["review"]), nil
	}
	if selector.Kind != "round" || selector.Round < 1 {
		return nil, apiError("预计算快照选择无效", 400)
	}
	if integerForComputation(state["round"]) == selector.Round {
		return current, nil
	}
	result, err := s.store.GetSnapshot(id, selector.Round)
	if err != nil {
		return nil, err
	}
	return objectForComputation(result["review"]), nil
}

func sourceForComputation(document review.Object, ref evidenceReference) (string, error) {
	if ref.Path == "" || ref.Symbol == "" || ref.StartLine < 1 || ref.EndLine < ref.StartLine || len(ref.Digest) != 64 {
		return "", apiError("预计算源码引用无效", 400)
	}
	for _, rawNode := range arrayForComputation(document["nodes"]) {
		for _, rawEvidence := range arrayForComputation(objectForComputation(rawNode)["evidence"]) {
			evidence := objectForComputation(rawEvidence)
			if evidence["path"] == ref.Path && evidence["symbol"] == ref.Symbol && integerForComputation(evidence["startLine"]) == ref.StartLine && integerForComputation(evidence["endLine"]) == ref.EndLine && evidence["digest"] == ref.Digest {
				if code, ok := evidence["code"].(string); ok {
					return code, nil
				}
				return "", apiError("此版本未保存源码片段，只有文件位置。", 422)
			}
		}
	}
	return "", apiError("源码引用不属于所选固定快照", 409)
}

func sourceLanguage(path string) string {
	value := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	if value == "" {
		return "text"
	}
	if len(value) > 64 {
		return "text"
	}
	return value
}

func warmSignature(state review.Object) string {
	document := objectForComputation(state["review"])
	baseline := objectForComputation(state["baseline"])
	if baseline == nil {
		baseline = objectForComputation(document["baseline"])
	}
	return fmt.Sprintf("%v:%v:%v", state["round"], objectForComputation(document["snapshot"])["fingerprint"], objectForComputation(baseline["snapshot"])["fingerprint"])
}

func referenceForWarm(evidence review.Object) evidenceReference {
	return evidenceReference{Path: textForComputation(evidence["path"]), Symbol: textForComputation(evidence["symbol"]), StartLine: integerForComputation(evidence["startLine"]), EndLine: integerForComputation(evidence["endLine"]), Digest: textForComputation(evidence["digest"])}
}

func validWarmState(value any) (review.Object, bool) {
	s := objectForComputation(value)
	return s, s != nil && integerForComputation(s["schemaVersion"]) == 1 && textForComputation(s["id"]) != "" && integerForComputation(s["round"]) > 0
}

func warmKey(id, signature string) string { return id + ":" + signature }
