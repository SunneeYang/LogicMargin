package review

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const MaxEvidenceCodeChars = 100000
const MaxEvidenceCodeLines = 2000

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var drivePattern = regexp.MustCompile(`^[a-zA-Z]:`)

func ParseSourceFiles(value any) ([]Object, error) {
	return capture(func() []Object { return parseSourceFiles(value) })
}
func parseSourceFiles(value any) []Object {
	files := []Object{}
	seen := map[string]bool{}
	for _, v := range arr(value, "来源文件清单") {
		f := obj(v, "来源文件")
		p := text(f["path"], "来源路径", 2000, true)
		invalid := strings.HasPrefix(p, "/") || strings.Contains(p, `\`) || drivePattern.MatchString(p)
		for _, part := range strings.Split(p, "/") {
			invalid = invalid || part == "" || part == "." || part == ".."
		}
		for _, r := range p {
			invalid = invalid || r < 32
		}
		if invalid {
			fail("来源路径必须是工作区内的规范相对路径")
		}
		h := text(f["sha256"], "来源文件摘要", 64, true)
		if !digestPattern.MatchString(h) {
			fail("来源摘要必须是 SHA-256")
		}
		seen[p] = true
		files = append(files, Object{"path": p, "sha256": h})
	}
	if len(files) == 0 || len(seen) != len(files) {
		fail("来源文件清单不能为空或包含重复路径")
	}
	sort.Slice(files, func(i, j int) bool { return lessUTF(str(files[i]["path"]), str(files[j]["path"])) })
	return files
}
func unique(a []any, label string) []any {
	seen := map[string]bool{}
	for _, v := range a {
		s := str(obj(v, label)["id"])
		if seen[s] {
			fail(label + "的 ID 重复")
		}
		seen[s] = true
	}
	return a
}
func parseTargets(value any) []any {
	r := []any{}
	seen := map[string]bool{}
	for _, v := range arr(value, "批注目标") {
		o := obj(v, "批注目标")
		t := Object{"kind": choice(o["kind"], "批注目标类型", "node", "edge", "scene", "review"), "id": id(o["id"], "批注目标 ID")}
		k := targetKey(t)
		seen[k] = true
		r = append(r, t)
	}
	if len(r) == 0 {
		fail("批注至少需要一个目标")
	}
	if len(seen) != len(r) {
		fail("批注目标重复")
	}
	return r
}
func parseReplies(value any) []any {
	r := []any{}
	for _, v := range arr(value, "批注回复") {
		o := obj(v, "批注回复")
		p := Object{"id": id(o["id"], "回复 ID"), "author": choice(o["author"], "回复作者", "reviewer", "agent"), "body": text(o["body"], "回复内容", 10000, true), "createdAt": date(o["createdAt"], "回复日期"), "revision": id(o["revision"], "回复版本")}
		if present(o, "round") {
			p["round"] = positive(o["round"], "回复轮次必须是正整数")
		}
		r = append(r, p)
	}
	return unique(r, "批注回复")
}
func ParseReview(value any) (Object, error) {
	return capture(func() Object { return parseReview(value) })
}
func parseReview(value any) Object {
	r := obj(value, "评审文件")
	if num(r["schemaVersion"]) != 1 {
		fail("不支持此评审文件版本；目前只支持 schemaVersion: 1")
	}
	snap := obj(r["snapshot"], "代码快照")
	if _, ok := snap["dirty"].(bool); !ok {
		fail("代码快照 dirty 必须是布尔值")
	}
	cov := obj(r["coverage"], "覆盖范围")
	scenes := []any{}
	for _, v := range arr(r["scenes"], "场景") {
		s := obj(v, "场景")
		scenes = append(scenes, Object{"id": id(s["id"], "场景 ID"), "title": text(s["title"], "场景标题", 200, true), "description": text(s["description"], "场景说明", 2000, false)})
	}
	unique(scenes, "场景")
	if len(scenes) == 0 {
		fail("评审文件至少需要一个场景")
	}
	sceneIDs := map[string]bool{}
	for _, scene := range objects(scenes) {
		sceneIDs[str(scene["id"])] = true
	}
	nodes := []any{}
	for _, v := range arr(r["nodes"], "节点") {
		n := obj(v, "节点")
		p := obj(n["position"], "节点坐标")
		scene := id(n["sceneId"], "节点所属场景")
		if !sceneIDs[scene] {
			fail("节点引用了不存在的场景")
		}
		q := Object{"id": id(n["id"], "节点 ID"), "sceneId": scene, "title": text(n["title"], "节点标题", 200, true), "kind": choice(n["kind"], "节点类型", "action", "decision", "result", "failure"), "summary": text(n["summary"], "节点摘要", 2000, false), "detail": text(n["detail"], "节点详情", 10000, false), "input": text(n["input"], "节点输入", 10000, false), "output": text(n["output"], "节点输出", 10000, false), "position": Object{"x": coordinate(p["x"], "节点横坐标", false), "y": coordinate(p["y"], "节点纵坐标", false)}}
		evidence := []any{}
		for _, v := range arr(n["evidence"], "源码依据") {
			e := obj(v, "源码依据")
			start := coordinate(e["startLine"], "源码起始行", true)
			end := coordinate(e["endLine"], "源码结束行", true)
			if end < start {
				fail("源码结束行不能早于起始行")
			}
			digest := text(e["digest"], "源码摘要", 200, true)
			var code string
			if present(e, "code") {
				code = text(e["code"], "源码片段", MaxEvidenceCodeChars, false)
				if !digestPattern.MatchString(digest) || strings.Contains(code, "\r\n") || strings.ContainsRune(code, 0) || end-start+1 > MaxEvidenceCodeLines || float64(len(strings.Split(code, "\n"))) != end-start+1 {
					fail("源码片段必须与依据行数一致，使用 LF 换行和 SHA-256 摘要，最多 2000 行")
				}
			}
			t := Object{"path": text(e["path"], "源码路径", 2000, true), "symbol": text(e["symbol"], "源码符号", 500, true), "startLine": start, "endLine": end, "digest": digest}
			if present(e, "code") {
				t["code"] = code
			}
			evidence = append(evidence, t)
		}
		q["evidence"] = evidence
		nodes = append(nodes, q)
	}
	unique(nodes, "节点")
	nodeMap := map[string]Object{}
	for _, node := range objects(nodes) {
		nodeMap[str(node["id"])] = node
	}
	edges := []any{}
	for _, v := range arr(r["edges"], "连线") {
		e := obj(v, "连线")
		scene := id(e["sceneId"], "连线所属场景")
		source := id(e["source"], "连线起点")
		target := id(e["target"], "连线终点")
		a, b := nodeMap[source], nodeMap[target]
		if !sceneIDs[scene] || a == nil || b == nil || a["sceneId"] != scene || b["sceneId"] != scene {
			fail("连线必须连接同一场景内的现有节点")
		}
		edges = append(edges, Object{"id": id(e["id"], "连线 ID"), "sceneId": scene, "source": source, "target": target, "label": text(e["label"], "连线标签", 200, false), "detail": text(e["detail"], "连线说明", 10000, false)})
	}
	unique(edges, "连线")
	comments := []any{}
	for _, v := range arr(r["comments"], "批注") {
		c := obj(v, "批注")
		p := Object{"id": id(c["id"], "批注 ID"), "body": text(c["body"], "批注内容", 10000, true), "targets": parseTargets(c["targets"]), "status": choice(c["status"], "批注状态", "open", "resolved", "needs-review"), "createdAt": date(c["createdAt"], "批注日期"), "revision": id(c["revision"], "批注版本")}
		if present(c, "reviewedRevision") {
			p["reviewedRevision"] = id(c["reviewedRevision"], "人工复核版本")
		}
		for _, pair := range [][2]string{{"originRound", "提出轮次"}, {"reviewedRound", "复核轮次"}} {
			if present(c, pair[0]) {
				p[pair[0]] = positive(c[pair[0]], pair[1]+"必须是正整数")
			}
		}
		if present(c, "basis") {
			p["basis"] = choice(c["basis"], "批注依据", "baseline")
		}
		if present(c, "replies") {
			p["replies"] = parseReplies(c["replies"])
		}
		comments = append(comments, p)
	}
	unique(comments, "批注")
	revision := id(r["revision"], "评审版本")
	result := Object{"schemaVersion": float64(1), "id": id(r["id"], "评审 ID"), "title": text(r["title"], "评审标题", 200, true), "description": text(r["description"], "评审说明", 10000, false), "revision": revision,
		"snapshot": Object{"repository": text(snap["repository"], "仓库路径", 2000, true), "commit": text(snap["commit"], "代码提交", 200, true), "fingerprint": text(snap["fingerprint"], "快照指纹", 200, true), "capturedAt": date(snap["capturedAt"], "快照日期"), "dirty": snap["dirty"]}, "coverage": Object{}, "scenes": scenes, "nodes": nodes, "edges": edges, "comments": comments}
	snapshot := result["snapshot"].(Object)
	if present(snap, "files") {
		snapshot["files"] = arr(parseSourceFiles(snap["files"]), "")
	}
	coverage := result["coverage"].(Object)
	for _, pair := range [][3]string{{"included", "已覆盖范围", "已覆盖说明"}, {"excluded", "未覆盖范围", "未覆盖说明"}} {
		items := []any{}
		for _, v := range arr(cov[pair[0]], pair[1]) {
			items = append(items, text(v, pair[2], 2000, false))
		}
		coverage[pair[0]] = items
	}
	coverage["note"] = text(cov["note"], "覆盖范围说明", 10000, false)
	paths := map[string]bool{}
	for _, f := range optionalObjects(snapshot["files"]) {
		paths[str(f["path"])] = true
	}
	for _, n := range objects(nodes) {
		for _, e := range objects(n["evidence"]) {
			if present(e, "code") && !paths[str(e["path"])] {
				fail("保存源码片段必须包含对应的来源文件清单")
			}
		}
	}
	if present(r, "baseline") {
		result["baseline"] = parseBaseline(r["baseline"], str(result["id"]))
	}
	for _, c := range objects(comments) {
		doc := result
		if c["basis"] == "baseline" {
			doc, _ = result["baseline"].(Object)
			if doc == nil || !allTargetsExist(doc, c) {
				fail("基线批注必须引用固定基线 B 的现有目标")
			}
		}
		rev := c["revision"]
		if present(c, "reviewedRevision") {
			rev = c["reviewedRevision"]
		}
		if rev != revision || (c["status"] != "resolved" && !allTargetsExist(doc, c)) {
			c["status"] = "needs-review"
		}
	}
	return result
}
func ParseBaseline(value any) (Object, error) {
	return capture(func() Object { return parseBaseline(value, "") })
}
func parseBaseline(value any, reviewID string) Object {
	s := obj(value, "固定基线")
	if present(s, "baseline") {
		fail("固定基线不能嵌套另一份基线")
	}
	b := parseReview(s)
	if reviewID != "" && b["id"] != reviewID {
		fail("固定基线必须属于相同评审 ID")
	}
	if len(objects(b["comments"])) > 0 {
		fail("固定基线不能包含批注")
	}
	return b
}
func targetKey(t Object) string { return str(t["kind"]) + ":" + str(t["id"]) }
func targetExists(r, t Object) bool {
	if r == nil {
		return false
	}
	switch t["kind"] {
	case "review":
		return r["id"] == t["id"]
	case "node":
		return find(r["nodes"], "id", t["id"]) != nil
	case "edge":
		return find(r["edges"], "id", t["id"]) != nil
	case "scene":
		return find(r["scenes"], "id", t["id"]) != nil
	}
	return false
}
func allTargetsExist(r, c Object) bool {
	for _, t := range objects(c["targets"]) {
		if !targetExists(r, t) {
			return false
		}
	}
	return true
}
func ValidateEvidenceCode(r Object) error {
	_, e := capture(func() bool { validateEvidenceCode(r); return true })
	return e
}
func validateEvidenceCode(r Object) {
	es := []Object{}
	for _, n := range objects(r["nodes"]) {
		for _, e := range objects(n["evidence"]) {
			if present(e, "code") {
				es = append(es, e)
			}
		}
	}
	if len(es) > 0 {
		snap := obj(r["snapshot"], "")
		files := parseSourceFiles(snap["files"])
		if snap["fingerprint"] != hash(manifestJSON(files)) {
			fail("源码片段的来源清单与快照指纹不一致")
		}
		for _, e := range es {
			if hash(str(e["code"])) != e["digest"] {
				fail(fmt.Sprintf("源码片段与摘要不一致：%s:%v–%v", e["path"], e["startLine"], e["endLine"]))
			}
		}
	}
	if b, ok := r["baseline"].(Object); ok {
		validateEvidenceCode(b)
	}
}
func checkedReview(v any) Object { r := parseReview(v); validateEvidenceCode(r); return r }
func ParseSessionOptions(value any) (Object, error) {
	return capture(func() Object { return parseOptions(request(value)) })
}
func parseOptions(v Object) Object {
	r := Object{}
	if present(v, "scope") {
		s, ok := v["scope"].(Object)
		if !ok || s == nil {
			fail("评审范围必须是对象")
		}
		p, ok := s["purpose"].(string)
		if !ok || trim(p) == "" || utfLength(p) > 10000 {
			fail("请填写本次独立评审的目的，最多 10000 字符")
		}
		scope := Object{"purpose": trim(p)}
		if present(s, "context") {
			c, ok := s["context"].(string)
			if !ok || trim(c) == "" || utfLength(c) > 1000 {
				fail("评审上下文须为非空文本，最多 1000 字符")
			}
			scope["context"] = trim(c)
		}
		r["scope"] = scope
	}
	if present(v, "cleanupPolicy") {
		r["cleanupPolicy"] = choice(v["cleanupPolicy"], "评审清理策略", "manual", "archive-on-approval")
	}
	if present(v, "baselineReview") {
		if v["baselineReview"] != true {
			fail("基线改造评审选项必须为 true")
		}
		r["baselineReview"] = true
	}
	return r
}
func ValidatePublication(value any, r Object) (Object, error) {
	return capture(func() Object { return validatePublication(value, r) })
}
func validatePublication(value any, r Object) Object {
	p, ok := value.(Object)
	if !ok || p == nil {
		fail("新版发布缺少来源核验和变更说明")
	}
	source, ok := p["source"].(Object)
	n := num(p["baseRound"])
	summary, sok := p["summary"].(string)
	valid := ok && source != nil && n >= 1 && n <= 9007199254740991 && n == float64(int64(n)) && sok && trim(summary) != "" && utfLength(summary) <= 10000
	if valid {
		_, valid = dateTime(str(source["checkedAt"]))
		valid = valid && source["algorithm"] == "sha256-path-content-v1" && digestPattern.MatchString(str(source["fingerprint"]))
	}
	if !valid {
		fail("新版发布的轮次、说明或来源核验无效")
	}
	out := Object{"baseRound": n, "summary": trim(summary)}
	if present(p, "unchangedReason") {
		s, ok := p["unchangedReason"].(string)
		if !ok || trim(s) == "" || utfLength(s) > 10000 {
			fail("流程未变时需要明确说明原因")
		}
		out["unchangedReason"] = trim(s)
	}
	files := parseSourceFiles(source["files"])
	fp := hash(manifestJSON(files))
	snap := obj(r["snapshot"], "")
	if source["fingerprint"] != fp || snap["fingerprint"] != fp {
		fail("来源清单与流程快照指纹不一致，请重新核对修改后的源码或文档")
	}
	if !present(snap, "files") || manifestJSON(parseSourceFiles(snap["files"])) != manifestJSON(files) {
		fail("流程必须包含与本轮核验一致的来源文件清单")
	}
	paths := map[string]bool{}
	for _, f := range files {
		paths[str(f["path"])] = true
	}
	for _, node := range objects(r["nodes"]) {
		for _, e := range objects(node["evidence"]) {
			if !paths[str(e["path"])] || !digestPattern.MatchString(str(e["digest"])) {
				fail("流程依据未包含在已核验的来源文件中，或片段摘要无效")
			}
		}
	}
	out["source"] = Object{"algorithm": "sha256-path-content-v1", "checkedAt": source["checkedAt"], "fingerprint": source["fingerprint"], "files": arr(files, "")}
	return out
}
