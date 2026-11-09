package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"logicmargin/internal/precompute"
	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
)

var sourceContextRoute = regexp.MustCompile(`^/api/review-sessions/([^/]+)/source-contexts$`)

type sourceContextRequest struct {
	Snapshot    snapshotSelector       `json:"snapshot"`
	Fingerprint string                 `json:"fingerprint"`
	Sources     []sourcecontext.Source `json:"sources"`
	Warm        bool                   `json:"warm,omitempty"`
}

func (s *Server) serveSourceContexts(w http.ResponseWriter, r *http.Request, pathname string) bool {
	match := sourceContextRoute.FindStringSubmatch(pathname)
	if match == nil {
		return false
	}
	fail := func(status int, message string) { sendJSON(w, r, status, review.Object{"error": message}) }
	if !localManagementRequest(r) {
		fail(403, "source_context_local_only")
		return true
	}
	if r.Method != http.MethodPost {
		fail(405, "method_not_allowed")
		return true
	}
	if s.contexts == nil {
		fail(503, "source_context_unavailable")
		return true
	}
	body, err := readJSON(r, false)
	if err != nil {
		fail(errorStatus(err), err.Error())
		return true
	}
	var input sourceContextRequest
	if decodeComputation(body, &input) != nil || len(input.Sources) > 16 || len(input.Sources) == 0 && !input.Warm {
		fail(400, "invalid_source_context_request")
		return true
	}
	id := match[1]
	state, err := s.store.Get(id, "current")
	if err != nil {
		fail(errorStatus(err), err.Error())
		return true
	}
	document, err := s.snapshotForComputation(id, state, input.Snapshot)
	if err != nil {
		fail(errorStatus(err), err.Error())
		return true
	}
	if input.Fingerprint == "" || objectForComputation(document["snapshot"])["fingerprint"] != input.Fingerprint {
		fail(409, "source_context_snapshot_mismatch")
		return true
	}
	// Validate the whole batch before writing any optional context.
	for _, source := range input.Sources {
		if !contextMatchesDocument(document, source) {
			fail(422, "source_context_mismatch")
			return true
		}
	}
	for _, source := range input.Sources {
		namespace := contextNamespace(id, document, source.Path, source.SHA256)
		if err := s.contexts.Put(r.Context(), namespace, source); err != nil {
			fail(422, "source_context_not_saved")
			return true
		}
	}
	if input.Warm {
		s.warmAfterContexts(id, state)
	}
	sendJSON(w, r, 200, review.Object{"saved": len(input.Sources), "sourceContextVersion": 1})
	return true
}

func errorStatus(err error) int {
	if value, ok := err.(*review.Error); ok {
		return value.Status
	}
	return 500
}

func contextFileSHA(document review.Object, path string) string {
	for _, raw := range arrayForComputation(objectForComputation(document["snapshot"])["files"]) {
		file := objectForComputation(raw)
		if file["path"] == path {
			return textForComputation(file["sha256"])
		}
	}
	return ""
}

// Bind cached context to the admitted evidence set, so new unverified ranges
// cannot turn an existing context into an oracle for unseen source text.
func contextNamespace(id string, document review.Object, path, fileSHA string) string {
	refs := map[string]bool{}
	for _, raw := range arrayForComputation(document["nodes"]) {
		for _, value := range arrayForComputation(objectForComputation(raw)["evidence"]) {
			evidence := objectForComputation(value)
			if evidence["path"] == path {
				encoded, _ := json.Marshal(referenceForWarm(evidence))
				refs[string(encoded)] = true
			}
		}
	}
	keys := make([]string, 0, len(refs))
	for key := range refs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	encoded, _ := json.Marshal([]any{id, path, fileSHA, keys})
	sum := sha256.Sum256(encoded)
	sum[6], sum[8] = sum[6]&15|0x40, sum[8]&63|0x80
	h := hex.EncodeToString(sum[:16])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func normalizedContext(raw string) string {
	return strings.ReplaceAll(strings.TrimPrefix(raw, "\ufeff"), "\r\n", "\n")
}

func contextSlice(content string, start, end int) (string, int, int, bool) {
	lines := strings.Split(content, "\n")
	if start < 1 || end < start || end > len(lines) {
		return "", 0, 0, false
	}
	code := strings.Join(lines[start-1:end], "\n")
	from := 0
	for i := 0; i < start-1; i++ {
		from += contextUnits(lines[i]) + 1
	}
	return code, from, from + contextUnits(code), true
}

func contextUnits(s string) int {
	units := 0
	for _, r := range s {
		units++
		if r > 0xffff {
			units++
		}
	}
	return units
}

func contextMatchesDocument(document review.Object, source sourcecontext.Source) bool {
	if source.SHA256 == "" || contextFileSHA(document, source.Path) != source.SHA256 || len(source.Content) > sourcecontext.MaxFileBytes {
		return false
	}
	sum := sha256.Sum256([]byte(source.Content))
	if hex.EncodeToString(sum[:]) != source.SHA256 {
		return false
	}
	content, found := normalizedContext(source.Content), false
	for _, raw := range arrayForComputation(document["nodes"]) {
		for _, value := range arrayForComputation(objectForComputation(raw)["evidence"]) {
			evidence := objectForComputation(value)
			if evidence["path"] != source.Path {
				continue
			}
			code, ok := evidence["code"].(string)
			if !ok {
				continue
			}
			captured, _, _, valid := contextSlice(content, integerForComputation(evidence["startLine"]), integerForComputation(evidence["endLine"]))
			if !valid || captured != code {
				return false
			}
			found = true
		}
	}
	return found
}

func (s *Server) structureSourceContext(ctx context.Context, id string, document review.Object, ref evidenceReference, saved string) *precompute.StructureContext {
	if s.contexts == nil || ctx.Err() != nil {
		return nil
	}
	fileSHA := contextFileSHA(document, ref.Path)
	if fileSHA == "" {
		return nil
	}
	source, err := s.contexts.Get(ctx, contextNamespace(id, document, ref.Path, fileSHA), ref.Path, fileSHA)
	if err != nil {
		return nil
	}
	content := normalizedContext(source.Content)
	code, from, to, valid := contextSlice(content, ref.StartLine, ref.EndLine)
	if !valid || code != saved {
		return nil
	}
	return &precompute.StructureContext{Code: content, From: from, To: to}
}

func (s *Server) warmAfterContexts(id string, state review.Object) {
	if s.warmQueue == nil || s.ctx == nil || s.ctx.Err() != nil {
		return
	}
	key := warmKey(id, warmSignature(state))
	s.warmMu.Lock()
	delete(s.warmSeen, key)
	order := s.warmOrder[:0]
	for _, old := range s.warmOrder {
		if old != key {
			order = append(order, old)
		}
	}
	s.warmOrder = order
	s.warmMu.Unlock()
	s.scheduleWarm(state)
}
