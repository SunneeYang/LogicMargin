package review

import "fmt"

func nodeLogic(n Object) []any {
	return fields(n, "sceneId", "title", "kind", "summary", "detail", "input", "output")
}
func edgeLogic(e Object) []any { return fields(e, "sceneId", "source", "target", "label", "detail") }
func evidenceLogic(n Object) []any {
	a := []any{}
	for _, e := range objects(n["evidence"]) {
		// Line offsets may move after unrelated edits without changing the cited code.
		a = append(a, fields(e, "path", "symbol", "digest"))
	}
	return a
}
func metadata(r Object) []any {
	scenes := []any{}
	for _, s := range objects(r["scenes"]) {
		scenes = append(scenes, fields(s, "id", "title", "description"))
	}
	c := obj(r["coverage"], "")
	return []any{r["title"], r["description"], ordered{{"included", c["included"]}, {"excluded", c["excluded"]}, {"note", c["note"]}}, jsSort(scenes)}
}
func LogicIdentity(r Object) string {
	nodes, edges := []any{}, []any{}
	for _, n := range objects(r["nodes"]) {
		nodes = append(nodes, []any{n["id"], nodeLogic(n)})
	}
	for _, e := range objects(r["edges"]) {
		edges = append(edges, []any{e["id"], edgeLogic(e)})
	}
	return stringify([]any{metadata(r), jsSort(nodes), jsSort(edges)})
}
func nodeContent(n Object) string { return stringify(append(nodeLogic(n), evidenceLogic(n))) }
func edgeContent(e Object) string { return stringify(edgeLogic(e)) }
func sceneContent(r Object, sceneID any) string {
	scene := find(r["scenes"], "id", sceneID)
	var header any
	if scene != nil {
		header = fields(scene, "title", "description")
	}
	nodes, edges := []any{}, []any{}
	for _, n := range objects(r["nodes"]) {
		if n["sceneId"] == sceneID {
			nodes = append(nodes, []any{n["id"], nodeContent(n)})
		}
	}
	for _, e := range objects(r["edges"]) {
		if e["sceneId"] == sceneID {
			edges = append(edges, []any{e["id"], edgeContent(e)})
		}
	}
	return stringify([]any{header, jsSort(nodes), jsSort(edges)})
}
func reviewContent(r Object) string {
	scenes := []any{}
	for _, s := range objects(r["scenes"]) {
		scenes = append(scenes, []any{s["id"], sceneContent(r, s["id"])})
	}
	return stringify([]any{r["title"], r["description"], r["coverage"], jsSort(scenes)})
}
func targetKeys(c Object) []any {
	a := []any{}
	for _, t := range objects(c["targets"]) {
		a = append(a, targetKey(t))
	}
	return jsSort(a)
}
func rebaseReview(before, after Object) Object {
	if before["id"] != after["id"] {
		fail("只能合并相同评审 ID 的版本")
	}
	if present(before, "baseline") && present(after, "baseline") && !equal(before["baseline"], after["baseline"]) {
		fail("固定基线已存在，不能随新版替换")
	}
	baseline, _ := before["baseline"].(Object)
	if baseline == nil {
		baseline, _ = after["baseline"].(Object)
	}
	for _, r := range []Object{before, after} {
		for _, c := range objects(r["comments"]) {
			if c["basis"] == "baseline" && (baseline == nil || !allTargetsExist(baseline, c)) {
				fail("基线批注必须引用固定基线 B 的现有目标")
			}
		}
	}
	previous := map[string]string{}
	current := map[string]string{}
	for _, pair := range []struct {
		r Object
		m map[string]string
	}{{before, previous}, {after, current}} {
		for _, n := range objects(pair.r["nodes"]) {
			pair.m["node:"+str(n["id"])] = nodeContent(n)
		}
		for _, e := range objects(pair.r["edges"]) {
			pair.m["edge:"+str(e["id"])] = edgeContent(e)
		}
	}
	affected := map[string]bool{}
	for k, v := range previous {
		if current[k] != v {
			affected[k] = true
		}
	}
	sceneChanged := map[string]bool{}
	for _, r := range []Object{before, after} {
		for _, s := range objects(r["scenes"]) {
			k := str(s["id"])
			sceneChanged[k] = sceneContent(before, k) != sceneContent(after, k)
		}
	}
	reviewChanged := reviewContent(before) != reviewContent(after)
	revisionChanged := before["revision"] != after["revision"] || obj(before["snapshot"], "")["fingerprint"] != obj(after["snapshot"], "")["fingerprint"]
	result := copyObject(after)
	if baseline != nil {
		result["baseline"] = baseline
	}
	comments := []any{}
	local := map[string]bool{}
	for _, c := range objects(before["comments"]) {
		cid := str(c["id"])
		local[cid] = true
		incoming := find(after["comments"], "id", cid)
		if incoming != nil && (c["body"] != incoming["body"] || c["basis"] != incoming["basis"] || !equal(targetKeys(c), targetKeys(incoming))) {
			fail(fmt.Sprintf("批注 %s 的内容或目标冲突；请先导出当前评审并处理冲突", cid))
		}
		merged := copyObject(c)
		newAgent := false
		if present(c, "replies") || (incoming != nil && present(incoming, "replies")) {
			replies := []any{}
			for _, r := range optionalObjects(c["replies"]) {
				replies = append(replies, r)
			}
			for _, reply := range optionalObjects(incoming["replies"]) {
				old := find(replies, "id", reply["id"])
				if old != nil {
					if !equal(fields(old, "author", "body", "createdAt", "revision"), fields(reply, "author", "body", "createdAt", "revision")) {
						fail(fmt.Sprintf("回复 %s 的内容冲突；请先导出当前评审并处理冲突", reply["id"]))
					}
				} else {
					replies = append(replies, reply)
					newAgent = newAgent || reply["author"] == "agent"
				}
			}
			merged["replies"] = replies
		}
		scopeChanged := false
		for _, t := range objects(c["targets"]) {
			scopeChanged = scopeChanged || affected[targetKey(t)] || (t["kind"] == "scene" && sceneChanged[str(t["id"])]) || (t["kind"] == "review" && reviewChanged)
		}
		rev := c["revision"]
		if present(c, "reviewedRevision") {
			rev = c["reviewedRevision"]
		}
		doc := after
		if c["basis"] == "baseline" {
			doc = baseline
		}
		confirmed := c["status"] == "resolved" && present(c, "reviewedRevision")
		if (!confirmed && (revisionChanged || rev != after["revision"])) || scopeChanged || newAgent || (c["status"] != "resolved" && !allTargetsExist(doc, c)) {
			merged["status"] = "needs-review"
		}
		comments = append(comments, merged)
	}
	for _, c := range objects(after["comments"]) {
		if local[str(c["id"])] {
			continue
		}
		c = copyObject(c)
		rev := c["revision"]
		if present(c, "reviewedRevision") {
			rev = c["reviewedRevision"]
		}
		doc := after
		if c["basis"] == "baseline" {
			doc = baseline
		}
		confirmed := c["status"] == "resolved" && present(c, "reviewedRevision")
		if !confirmed && (rev != after["revision"] || (c["status"] != "resolved" && !allTargetsExist(doc, c))) {
			c["status"] = "needs-review"
		}
		comments = append(comments, c)
	}
	result["comments"] = comments
	return result
}
func humanFeedback(c Object) string {
	targets, replies := []any{}, []any{}
	for _, t := range objects(c["targets"]) {
		targets = append(targets, fields(t, "kind", "id"))
	}
	for _, r := range optionalObjects(c["replies"]) {
		if r["author"] == "reviewer" {
			replies = append(replies, fields(r, "id", "body", "createdAt", "revision"))
		}
	}
	return stringify([]any{c["body"], c["basis"], jsSort(targets), jsSort(replies)})
}
func pendingFeedback(r Object, history []Object) []any {
	type submitted struct {
		record, comment Object
		time            int64
	}
	latest := map[string]submitted{}
	for _, record := range history {
		doc := obj(record["review"], "")
		if record["kind"] != "logic-margin-feedback" || doc["id"] != r["id"] {
			continue
		}
		date, _ := dateTime(str(record["createdAt"]))
		t := date.UnixMilli()
		for _, c := range objects(doc["comments"]) {
			old, ok := latest[str(c["id"])]
			if !ok || t >= old.time {
				latest[str(c["id"])] = submitted{record, c, t}
			}
		}
	}
	return filter(r["comments"], func(c Object) bool {
		if c["status"] != "open" {
			return false
		}
		s, ok := latest[str(c["id"])]
		if !ok {
			return true
		}
		doc := obj(s.record["review"], "")
		return doc["revision"] != r["revision"] || obj(doc["snapshot"], "")["fingerprint"] != obj(r["snapshot"], "")["fingerprint"] || humanFeedback(s.comment) != humanFeedback(c)
	})
}
func parseRecord(v any) Object {
	s := obj(v, "评审记录")
	if num(s["schemaVersion"]) != 1 {
		fail("不支持此评审记录版本")
	}
	kind := choice(s["kind"], "评审记录类型", "logic-margin-feedback", "logic-margin-approval")
	r := parseReview(s["review"])
	cs := objects(r["comments"])
	if kind == "logic-margin-feedback" {
		if len(cs) == 0 {
			fail("意见包只能包含待处理批注，且至少需要一条")
		}
		for _, c := range cs {
			if c["status"] != "open" {
				fail("意见包只能包含待处理批注，且至少需要一条")
			}
		}
	} else {
		for _, c := range cs {
			if c["status"] != "resolved" {
				fail("通过记录不能包含未解决的批注")
			}
		}
	}
	return Object{"schemaVersion": float64(1), "kind": kind, "id": id(s["id"], "评审记录 ID"), "createdAt": date(s["createdAt"], "评审记录日期"), "review": r}
}
func parseHistory(v any) []any {
	a, ok := v.([]any)
	if !ok {
		if os, ok := v.([]Object); ok {
			a = make([]any, len(os))
			for i := range os {
				a[i] = os[i]
			}
		} else {
			fail("评审历史必须是数组")
		}
	}
	result := []any{}
	for _, v := range a {
		r := parseRecord(v)
		existing := find(result, "id", r["id"])
		if existing != nil {
			if !equal(existing, r) {
				fail(fmt.Sprintf("评审记录 %s 的内容冲突", r["id"]))
			}
		} else {
			result = append(result, r)
		}
	}
	return result
}
func createRecord(r Object, kind string) Object {
	r = parseReview(r)
	if kind == "feedback" {
		r["comments"] = filter(r["comments"], func(c Object) bool { return c["status"] == "open" })
		if len(objects(r["comments"])) == 0 {
			fail("没有可提交的待处理批注")
		}
	} else {
		for _, c := range objects(r["comments"]) {
			if c["status"] != "resolved" {
				fail("仍有待处理或待复核批注，不能确认通过")
			}
		}
	}
	return Object{"schemaVersion": float64(1), "kind": "logic-margin-" + kind, "id": newID(), "createdAt": now(), "review": r}
}
func submissionRound(s Object, recordID any) float64 {
	index := -1
	history := objects(s["history"])
	for i, r := range history {
		if r["id"] == recordID {
			index = i
			break
		}
	}
	if index < 0 {
		return 0
	}
	snapshots := objects(s["snapshots"])
	for i := len(snapshots) - 1; i >= 0; i-- {
		sn := snapshots[i]
		after := -1
		if present(sn, "afterSubmission") {
			for j, r := range history {
				if r["id"] == sn["afterSubmission"] {
					after = j
					break
				}
			}
		}
		if index > after {
			return num(sn["round"])
		}
	}
	return 0
}
func commentOrigin(s, c Object) Object {
	if c["basis"] == "baseline" {
		return nil
	}
	snapshots := objects(s["snapshots"])
	if present(c, "originRound") {
		for _, sn := range snapshots {
			if equal(sn["round"], c["originRound"]) {
				return Object{"round": c["originRound"], "exact": true}
			}
		}
		return nil
	}
	for _, r := range objects(s["history"]) {
		if find(obj(r["review"], "")["comments"], "id", c["id"]) != nil {
			n := submissionRound(s, r["id"])
			if n > 0 {
				return Object{"round": n, "exact": false}
			}
			break
		}
	}
	var first, last, fallback Object
	created, _ := dateTime(str(c["createdAt"]))
	for _, sn := range snapshots {
		r := obj(sn["review"], "")
		if fallback == nil && find(r["comments"], "id", c["id"]) != nil {
			fallback = sn
		}
		match := false
		for _, t := range objects(c["targets"]) {
			match = match || targetExists(r, t)
		}
		if r["revision"] == c["revision"] && match {
			if first == nil {
				first = sn
			}
			opened, _ := dateTime(str(sn["openedAt"]))
			if !opened.After(created) {
				last = sn
			}
		}
	}
	if last == nil {
		last = first
	}
	if last == nil {
		last = fallback
	}
	if last != nil {
		return Object{"round": last["round"], "exact": false}
	}
	return nil
}
func discussionEditPermissions(s, review Object) (map[string]bool, map[string]bool) {
	comments, replies := map[string]bool{}, map[string]bool{}
	frozenComments, frozenReplies := map[string]bool{}, map[string]bool{}
	for _, record := range objects(s["history"]) {
		for _, c := range objects(obj(record["review"], "")["comments"]) {
			frozenComments[str(c["id"])] = true
			for _, reply := range optionalObjects(c["replies"]) {
				frozenReplies[stringify([]any{c["id"], reply["id"]})] = true
			}
		}
	}
	currentRound := func(item Object, key string) bool {
		if present(item, key) {
			return equal(item[key], s["round"])
		}
		return num(s["round"]) == 1
	}
	for _, c := range objects(review["comments"]) {
		id := str(c["id"])
		comments[id] = c["revision"] == review["revision"] && currentRound(c, "originRound") && !frozenComments[id]
		for _, reply := range optionalObjects(c["replies"]) {
			key := stringify([]any{c["id"], reply["id"]})
			replies[key] = reply["author"] == "reviewer" && reply["revision"] == review["revision"] && currentRound(reply, "round") && !frozenReplies[key]
		}
	}
	return comments, replies
}
func currentSession(s Object) Object {
	r := copyObject(obj(s["review"], ""))
	r["comments"] = listMap(r["comments"], func(c Object) Object { p := copyObject(c); p["status"] = "open"; return p })
	pending := map[string]bool{}
	for _, c := range objects(pendingFeedback(r, objects(s["history"]))) {
		pending[str(c["id"])] = true
	}
	r = copyObject(obj(s["review"], ""))
	delete(r, "baseline")
	out := copyObject(s)
	out["review"] = r
	out["view"] = "current"
	if baseline, ok := obj(s["review"], "")["baseline"].(Object); ok {
		snap := copyObject(obj(baseline["snapshot"], ""))
		delete(snap, "files")
		out["baseline"] = Object{"revision": baseline["revision"], "snapshot": snap}
	}
	out["snapshots"] = listMap(s["snapshots"], func(sn Object) Object { r := copyObject(sn); delete(r, "review"); return r })
	out["history"] = listMap(s["history"], func(record Object) Object {
		r := obj(record["review"], "")
		n := submissionRound(s, record["id"])
		if n == 0 {
			n = 1
		}
		return Object{"id": record["id"], "kind": record["kind"], "createdAt": record["createdAt"], "round": n, "revision": r["revision"], "fingerprint": obj(r["snapshot"], "")["fingerprint"]}
	})
	submitted, origins := []any{}, []any{}
	editableComments, editableReplies := []any{}, []any{}
	commentPermissions, replyPermissions := discussionEditPermissions(s, r)
	for _, c := range objects(r["comments"]) {
		if !pending[str(c["id"])] {
			submitted = append(submitted, c["id"])
		}
		if origin := commentOrigin(s, c); origin != nil {
			origin["commentId"] = c["id"]
			origins = append(origins, origin)
		}
		if commentPermissions[str(c["id"])] {
			editableComments = append(editableComments, c["id"])
		}
		for _, reply := range optionalObjects(c["replies"]) {
			if replyPermissions[stringify([]any{c["id"], reply["id"]})] {
				editableReplies = append(editableReplies, Object{"commentId": c["id"], "replyId": reply["id"]})
			}
		}
	}
	out["submittedCommentIds"] = submitted
	out["commentOrigins"] = origins
	out["editableDiscussion"] = Object{"comments": editableComments, "replies": editableReplies}
	return out
}
