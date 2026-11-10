// Package agent implements the review CLI independently of daemon lifecycle.
package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"time"
	"unicode/utf8"

	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
)

func textFile(ctx context.Context, path string, maxBytes int64) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() > maxBytes {
		return "", fmt.Errorf("文件过大：%s", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if int64(len(b)) > maxBytes {
		return "", fmt.Errorf("文件过大：%s", path)
	}
	if !utf8.Valid(b) {
		b = []byte(string([]rune(string(b))))
	}
	if int64(len(b)) > maxBytes {
		return "", fmt.Errorf("文件过大：%s", path)
	}
	return string(b), nil
}
func readReview(ctx context.Context, path string) (object, error) {
	s, err := textFile(ctx, path, maxFileBytes)
	if err != nil {
		return nil, err
	}
	var v any
	if err := review.CheckJSONUnicode([]byte(s)); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil, err
	}
	return review.ParseReview(v)
}
func checkReviewSize(doc object) error {
	bytes, err := jsonBytes(doc)
	if err != nil {
		return err
	}
	if len(bytes) > maxFileBytes {
		return errors.New("基线与当前流程合计超过10MB")
	}
	return nil
}
func publicationReplies(ctx context.Context, path string) ([]any, error) {
	s, err := textFile(ctx, path, maxFileBytes)
	if err != nil {
		return nil, err
	}
	var v any
	if err := review.CheckJSONUnicode([]byte(s)); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return nil, err
	}
	values, ok := v.([]any)
	if !ok {
		return nil, errors.New("发布回复必须是数组")
	}
	result := make([]any, 0, len(values))
	for _, v := range values {
		o := obj(v)
		id, idOK := o["commentId"].(string)
		body, bodyOK := o["body"].(string)
		if !idOK || trim(id) == "" || utf16Len(id) > 200 || !bodyOK || trim(body) == "" || utf16Len(body) > 10000 {
			return nil, errors.New("发布回复须包含有效的 commentId 与非空正文，正文最多 10000 字符")
		}
		result = append(result, object{"commentId": id, "body": body})
	}
	return result, nil
}
func uuid() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	h := hex.EncodeToString(bytes[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}

// Run executes existing review commands. The root command owns service startup
// and signal handling; cancellation supplied here reaches every HTTP request.
func Run(ctx context.Context, args []string, out, errOut io.Writer, opts Options) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(args) == 0 || args[0] == "help" {
		_, err := io.WriteString(out, help)
		return err
	}
	p, o, showHelp, err := parseArgs(args, opts)
	if err != nil {
		return err
	}
	if showHelp {
		_, err := io.WriteString(out, help)
		return err
	}
	if err := validateArgs(p, o); err != nil {
		return err
	}
	command := p[0]
	id := ""
	argument := ""
	if len(p) > 1 {
		id = p[1]
	}
	if len(p) > 2 {
		argument = p[2]
	}
	var prepared, baselineSource, preparedBaseline, source object
	var contexts, baselineContexts []sourcecontext.Source
	if contains(command, "start", "verify", "revise") {
		path := id
		if command == "revise" {
			path = argument
		}
		prepared, err = readReview(ctx, path)
		if err != nil {
			return err
		}
	}
	if o.baselineReview && prepared["baseline"] != nil {
		return errors.New("--baseline-review 需要原系统图，输入文件已包含另一份固定基线")
	}
	if o.has("baseline-file") {
		if prepared["baseline"] != nil {
			return errors.New("评审文件已包含基线，请只提供一个修改前基线")
		}
		b, err := readReview(ctx, o.value("baseline-file"))
		if err != nil {
			return err
		}
		b, err = checkedBaseline(b, str(prepared["id"]))
		if err != nil {
			return err
		}
		prepared["baseline"] = b
	}
	if prepared != nil && prepared["baseline"] != nil && command != "revise" {
		if !o.has("baseline-source-root") {
			return errors.New("核验修改前基线需要 --baseline-source-root，不能使用当前源码目录代替")
		}
		if command == "verify" {
			baselineSource, err = VerifySources(ctx, obj(prepared["baseline"]), o.value("baseline-source-root"))
		} else {
			baselineSource, baselineContexts, err = VerifySourcesWithContexts(ctx, obj(prepared["baseline"]), o.value("baseline-source-root"))
		}
		if err != nil {
			return err
		}
	} else if o.has("baseline-source-root") {
		return errors.New("--baseline-source-root 需要修改前基线文件或嵌入的基线")
	}
	if command == "baseline" {
		b, err := readReview(ctx, argument)
		if err != nil {
			return err
		}
		preparedBaseline, err = checkedBaseline(b, "")
		if err != nil {
			return err
		}
		baselineSource, baselineContexts, err = VerifySourcesWithContexts(ctx, preparedBaseline, o.value("source-root"))
		if err != nil {
			return err
		}
	}
	if command == "revise" || command == "verify" || command == "start" && (o.has("source-root") || o.baselineReview || prepared["baseline"] != nil) {
		root := o.value("source-root")
		if root == "" {
			root, err = os.Getwd()
			if err != nil {
				return err
			}
		}
		if command == "verify" {
			source, err = VerifySources(ctx, prepared, root)
		} else {
			source, contexts, err = VerifySourcesWithContexts(ctx, prepared, root)
		}
		if err != nil {
			return err
		}
	}
	if o.baselineReview {
		prepared["comments"] = []any{}
		b, err := checkedBaseline(copyObject(prepared), str(prepared["id"]))
		if err != nil {
			return err
		}
		prepared["baseline"] = b
	}
	if prepared != nil {
		if err := checkReviewSize(prepared); err != nil {
			return err
		}
	}
	var replies []any
	if o.has("replies-file") {
		replies, err = publicationReplies(ctx, o.value("replies-file"))
		if err != nil {
			return err
		}
	}
	if command == "verify" {
		result := copyObject(source)
		if baselineSource != nil {
			result["baseline"] = baselineSource
		}
		return writeJSON(out, result)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !o.explicitURL && opts.URL == "" && opts.ResolveURL != nil {
		resolved, err := opts.ResolveURL(ctx)
		if err != nil {
			return err
		}
		o.url, err = baseURL(resolved)
		if err != nil {
			return err
		}
		if !o.explicitPublicURL && opts.PublicURL == "" {
			o.publicURL = o.url
		}
	}
	c := client{ctx, o.url}
	if command == "list" {
		state := o.value("state")
		if state == "" {
			state = "active"
		}
		query := url.Values{"state": []string{state}}
		if o.has("context") {
			query.Set("context", o.value("context"))
		}
		result, err := c.payload("?"+query.Encode(), nil, 30*time.Second)
		if err != nil {
			return err
		}
		sessions, ok := obj(result)["sessions"].([]any)
		if !ok {
			return errors.New("服务端返回了无效会话列表")
		}
		for _, v := range sessions {
			s := obj(v)
			if _, ok := s["id"].(string); !ok {
				return errors.New("服务端返回了无效会话列表")
			}
			if _, ok := s["title"].(string); !ok || !safeInteger(s["version"]) {
				return errors.New("服务端返回了无效会话列表")
			}
		}
		return writeJSON(out, result)
	}
	var current object
	switch command {
	case "start":
		isolated := o.has("context") || o.has("purpose")
		body := object{"review": prepared}
		if isolated {
			purpose := o.value("purpose")
			if !o.has("purpose") {
				purpose = trim(str(prepared["description"]))
				if purpose == "" {
					purpose = str(prepared["title"])
				}
			}
			scope := object{"purpose": purpose}
			if o.has("context") {
				scope["context"] = o.value("context")
			}
			checked, err := review.ParseSessionOptions(object{"scope": scope})
			if err != nil {
				return err
			}
			doc := copyObject(prepared)
			doc["comments"] = []any{}
			body["review"] = doc
			body["scope"] = checked["scope"]
		}
		if o.baselineReview {
			body["baselineReview"] = true
		}
		if o.cleanupOnApproval {
			body["cleanupPolicy"] = "archive-on-approval"
		}
		current, err = c.required("", body)
	case "restore":
		current, err = c.required("/"+encodeURIComponent(id)+"/archive", nil)
	case "get", "cleanup":
		current, err = c.activeOrArchived("/" + encodeURIComponent(id))
	default:
		current, err = c.required("/"+encodeURIComponent(id), nil)
	}
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	path := "/" + encodeURIComponent(str(current["id"]))
	switch command {
	case "baseline":
		baseline, err := checkedBaseline(preparedBaseline, str(obj(current["review"])["id"]))
		if err != nil {
			return err
		}
		doc := copyObject(obj(current["review"]))
		doc["baseline"] = baseline
		if err := checkReviewSize(doc); err != nil {
			return err
		}
		current, err = c.required(path+"/baseline", object{"expectedVersion": current["version"], "baseline": baseline})
		if err != nil {
			return err
		}
	case "ack":
		current, err = c.required(path+"/ack", object{"submissionId": argument})
		if err != nil {
			return err
		}
	case "cleanup":
		mode := o.value("mode")
		if mode == "" {
			mode = "archive"
		}
		result, err := c.cleanup(current, mode, o.force)
		if err != nil {
			return err
		}
		return writeJSON(out, result)
	case "restore":
		current, err = c.required(path+"/restore", object{"expectedVersion": current["version"]})
		if err != nil {
			return err
		}
	case "reply":
		if !o.has("body-file") && !o.has("body") {
			return errors.New("reply 需要 --body-file <text-file> 或 --body <text>")
		}
		body := o.value("body")
		if !o.has("body") {
			body, err = textFile(ctx, o.value("body-file"), 40000)
			if err != nil {
				return err
			}
		}
		body = trim(body)
		if body == "" || utf16Len(body) > 10000 {
			return errors.New("回复须为非空文本，最多 10000 字符")
		}
		doc := obj(current["review"])
		found := false
		for _, v := range arr(doc["comments"]) {
			if obj(v)["id"] == argument {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("批注不存在：%s", argument)
		}
		replyID, err := uuid()
		if err != nil {
			return err
		}
		reply := object{"id": replyID, "author": "agent", "body": body, "createdAt": now(), "revision": doc["revision"]}
		current, err = c.required(path+"/mutations", object{"round": current["round"], "revision": doc["revision"], "fingerprint": obj(doc["snapshot"])["fingerprint"], "mutations": []any{object{"kind": "add-reply", "commentId": argument, "reply": reply}}})
		if err != nil {
			return err
		}
	case "revise":
		if o.baseRound != current["round"] {
			return fmt.Errorf("发布基于第 %.0f 轮，但会话已是第 %.0f 轮；请用 get 核对新版后重新修改", o.baseRound, number(current["round"]))
		}
		if prepared["id"] != obj(current["review"])["id"] {
			return errors.New("新版评审必须沿用原评审 ID")
		}
		publication := object{"baseRound": o.baseRound, "summary": trim(o.value("summary")), "source": source}
		if o.has("unchanged-reason") {
			publication["unchangedReason"] = trim(o.value("unchanged-reason"))
		}
		body := object{"expectedVersion": current["version"], "review": prepared, "publication": publication}
		if o.has("replies-file") {
			body["replies"] = replies
		}
		current, err = c.required(path+"/revise", body)
		if err != nil {
			return err
		}
	}
	baselineDoc := preparedBaseline
	if command == "start" {
		baselineDoc = obj(prepared["baseline"])
	}
	analysisContext := publishedSourceContexts(ctx, o.url, command, current, prepared, baselineDoc, contexts, baselineContexts, o.baselineReview)
	if contains(command, "start", "revise", "resume", "restore") {
		if _, err := fmt.Fprintf(errOut, "审查地址：%s\n", reviewLink(o.publicURL, str(current["id"]))); err != nil {
			return err
		}
	}
	if command == "wait" || o.wait {
		return waitForSubmission(c, current, o, out, errOut, opts.ConsumeSubmission && !o.noConsume)
	}
	if command == "get" {
		return writeJSON(out, current)
	}
	doc := obj(current["review"])
	if command == "comments" {
		result := object{"sessionId": current["id"], "round": current["round"], "phase": current["phase"], "revision": doc["revision"], "snapshot": doc["snapshot"], "comments": doc["comments"]}
		if v, ok := current["scope"]; ok {
			result["scope"] = v
		}
		return writeJSON(out, result)
	}
	result := object{"sessionId": current["id"], "version": current["version"], "round": current["round"], "phase": current["phase"], "url": reviewLink(o.publicURL, str(current["id"]))}
	if analysisContext != nil {
		result["analysisContext"] = analysisContext
	}
	for _, k := range []string{"baselineReview", "scope", "cleanupPolicy"} {
		if v, ok := current[k]; ok {
			result[k] = v
		}
	}
	return writeJSON(out, result)
}
