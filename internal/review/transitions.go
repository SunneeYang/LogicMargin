package review

import (
	"bytes"
	"compress/gzip"
	"errors"
	"os"
	"path/filepath"
	"unicode/utf8"
)

func (s *Store) Create(value any, view string, options Object) (Object, error) {
	return captureIO(func() (Object, error) {
		id := newID()
		e := s.acquire(id)
		defer s.release(id, e)
		incoming := checkedReview(value)
		if options == nil {
			options = Object{}
		}
		metadata := parseOptions(options)
		if metadata["baselineReview"] == true {
			baseline, ok := incoming["baseline"].(Object)
			if !ok {
				fail("基线改造评审必须提供固定基线 B")
			}
			currentGraph := copyObject(incoming)
			delete(currentGraph, "baseline")
			delete(currentGraph, "comments")
			baselineGraph := copyObject(baseline)
			delete(baselineGraph, "comments")
			if !equal(currentGraph, baselineGraph) {
				fail("基线改造评审的初始图必须与固定基线 B 一致")
			}
		}
		review := copyObject(incoming)
		comments := incoming["comments"]
		if present(metadata, "scope") {
			comments = []any{}
		}
		review["comments"] = listMap(comments, func(c Object) Object {
			r := copyObject(c)
			r["originRound"] = float64(1)
			if present(c, "reviewedRound") {
				r["reviewedRound"] = float64(1)
			}
			if present(c, "replies") {
				r["replies"] = listMap(c["replies"], func(reply Object) Object { r := copyObject(reply); r["round"] = float64(1); return r })
			}
			return r
		})
		now := now()
		state := Object{"schemaVersion": float64(1), "id": id, "version": float64(1), "round": float64(1), "phase": "awaiting-review", "createdAt": now, "updatedAt": now, "review": review, "history": []any{}, "snapshots": []any{Object{"round": float64(1), "openedAt": now, "review": clone(review)}}}
		for k, v := range metadata {
			state[k] = v
		}
		if err := s.persist(state, e); err != nil {
			return nil, err
		}
		return s.output(state, view), nil
	})
}
func (s *Store) AttachBaseline(id string, value any, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		input := request(value)
		integer(input["expectedVersion"], "版本")
		return s.update(id, view, func(state Object) (Object, bool) {
			review := obj(state["review"], "")
			baseline := parseBaseline(input["baseline"], str(review["id"]))
			validateEvidenceCode(baseline)
			if present(review, "baseline") {
				if equal(review["baseline"], baseline) {
					return state, false
				}
				fail("固定基线已存在，不能替换", 409)
			}
			if !equal(input["expectedVersion"], state["version"]) {
				fail("会话已有更新，请读取最新版本后补录基线", 409)
			}
			next := copyObject(state)
			r := copyObject(review)
			r["baseline"] = baseline
			next["review"] = r
			return next, true
		})
	})
}
func (s *Store) Mutate(id string, value any, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		batch := request(value)
		var raw []any
		switch a := batch["mutations"].(type) {
		case []any:
			raw = a
		case []Object:
			for _, o := range a {
				raw = append(raw, o)
			}
		}
		if len(raw) == 0 {
			fail("每批至少需要一项操作")
		}
		mutations := []Object{}
		for _, v := range raw {
			mutations = append(mutations, request(v))
		}
		return s.update(id, view, func(state Object) (Object, bool) {
			original := obj(state["review"], "")
			if batch["revision"] != original["revision"] || batch["fingerprint"] != obj(original["snapshot"], "")["fingerprint"] {
				fail("流程已更新，请恢复会话并核对新版后重试；未保存操作应保留导出", 409)
			}
			if (num(state["round"]) > 1 || present(batch, "round")) && !equal(batch["round"], state["round"]) {
				fail("流程轮次已更新或未提供，请查看当前版本后重试", 409)
			}
			for _, m := range mutations {
				if m["kind"] == "set-status" && !equal(batch["expectedVersion"], state["version"]) {
					fail("批注已有更新，请查看最新回复后再确认状态", 409)
				}
			}
			review := original
			awaiting := state["phase"] == "agent-working" || state["phase"] == "feedback-ready"
			hasAgent, changed := false, false
			for _, m := range mutations {
				switch m["kind"] {
				case "add-comment":
					raw := request(m["comment"])
					probe := copyObject(review)
					probe["comments"] = []any{raw}
					candidate := objects(checkedReview(probe)["comments"])[0]
					existing := find(review["comments"], "id", candidate["id"])
					if existing != nil {
						if !equal(fields(existing, "body", "basis", "targets", "createdAt", "revision"), fields(candidate, "body", "basis", "targets", "createdAt", "revision")) {
							fail("相同批注标识的内容冲突", 409)
						}
						continue
					}
					doc := review
					if candidate["basis"] == "baseline" {
						doc, _ = review["baseline"].(Object)
					}
					if candidate["revision"] != review["revision"] || candidate["status"] != "open" || len(optionalObjects(candidate["replies"])) > 0 || str(candidate["reviewedRevision"]) != "" || present(candidate, "reviewedRound") || doc == nil || !allTargetsExist(doc, candidate) {
						fail("新批注必须指向所属流程图的现有目标且处于待处理状态")
					}
					candidate["originRound"] = state["round"]
					r := copyObject(review)
					comments := append([]any{}, arr(review["comments"], "")...)
					r["comments"] = append(comments, candidate)
					review = checkedReview(r)
					changed = true
				case "add-reply":
					commentID := requestID(m["commentId"])
					comment := find(review["comments"], "id", commentID)
					if comment == nil {
						fail("找不到此批注", 404)
					}
					probe := copyObject(review)
					c := copyObject(comment)
					c["replies"] = []any{m["reply"]}
					probe["comments"] = []any{c}
					candidate := objects(objects(checkedReview(probe)["comments"])[0]["replies"])[0]
					existing := findOrNil(comment["replies"], "id", candidate["id"])
					if existing != nil {
						if !equal(fields(existing, "author", "body", "createdAt", "revision"), fields(candidate, "author", "body", "createdAt", "revision")) {
							fail("相同回复标识的内容冲突", 409)
						}
						continue
					}
					if candidate["revision"] != review["revision"] {
						fail("回复所属版本已过期", 409)
					}
					if candidate["author"] == "agent" {
						hasAgent = true
						awaiting = true
					}
					candidate["round"] = state["round"]
					r := copyObject(review)
					r["comments"] = listMap(review["comments"], func(c Object) Object {
						if c["id"] != commentID {
							return c
						}
						p := copyObject(c)
						replies := []any{}
						for _, v := range optionalObjects(c["replies"]) {
							replies = append(replies, v)
						}
						p["replies"] = append(replies, candidate)
						if candidate["author"] == "agent" {
							p["status"] = "needs-review"
						}
						return p
					})
					review = checkedReview(r)
					changed = true
				case "edit-comment", "edit-reply":
					replyEdit := m["kind"] == "edit-reply"
					for key := range m {
						if key != "kind" && key != "commentId" && key != "from" && key != "body" && !(replyEdit && key == "replyId") {
							fail("编辑讨论只能修改正文")
						}
					}
					commentID := requestID(m["commentId"])
					comment := find(review["comments"], "id", commentID)
					if comment == nil {
						fail("找不到此批注", 404)
					}
					item, label := comment, "批注内容"
					replyID := ""
					editableComments, editableReplies := discussionEditPermissions(state, review)
					allowed := editableComments[commentID]
					if replyEdit {
						replyID = requestID(m["replyId"])
						item = findOrNil(comment["replies"], "id", replyID)
						if item == nil {
							fail("找不到此回复", 404)
						}
						label = "回复内容"
						allowed = editableReplies[stringify([]any{commentID, replyID})]
					}
					if !allowed {
						fail("只能修改本轮尚未提交的讨论", 409)
					}
					integer(batch["expectedVersion"], "版本")
					from := text(m["from"], label, 10000, true)
					body := trim(text(m["body"], label, 10000, true))
					if !utf8.ValidString(from) || !utf8.ValidString(body) {
						fail("JSON 必须是有效 UTF-8 文本")
					}
					// An edit can commit before its response reaches the client's pending queue.
					if body == item["body"] {
						continue
					}
					if !equal(batch["expectedVersion"], state["version"]) {
						fail("讨论已有更新，请读取最新内容后重试", 409)
					}
					if from != item["body"] {
						fail("讨论内容已有变化，请核对最新内容", 409)
					}
					r := copyObject(review)
					r["comments"] = listMap(review["comments"], func(c Object) Object {
						if c["id"] != commentID {
							return c
						}
						p := copyObject(c)
						if replyEdit {
							p["replies"] = listMap(c["replies"], func(reply Object) Object {
								if reply["id"] != replyID {
									return reply
								}
								next := copyObject(reply)
								next["body"] = body
								return next
							})
						} else {
							p["body"] = body
						}
						return p
					})
					review = checkedReview(r)
					changed = true
				case "set-status":
					status := choice(m["status"], "批注状态", "open", "needs-review", "resolved")
					from := choice(m["from"], "批注状态", "open", "needs-review", "resolved")
					comment := find(review["comments"], "id", m["commentId"])
					if comment == nil {
						fail("找不到此批注", 404)
					}
					if status == "resolved" && awaiting {
						fail("代理处理中，新版流程尚未发布，不能确认解决", 409)
					}
					if comment["status"] != from || m["reviewedRevision"] != review["revision"] {
						fail("批注状态或版本已有变化，请核对最新内容", 409)
					}
					if comment["status"] == status && comment["reviewedRevision"] == review["revision"] && equal(comment["reviewedRound"], state["round"]) {
						continue
					}
					r := copyObject(review)
					r["comments"] = listMap(review["comments"], func(c Object) Object {
						if c["id"] != comment["id"] {
							return c
						}
						p := copyObject(c)
						p["status"] = status
						p["reviewedRevision"] = review["revision"]
						p["reviewedRound"] = state["round"]
						return p
					})
					review = checkedReview(r)
					changed = true
				default:
					fail("不支持此会话操作")
				}
			}
			if !changed {
				return state, false
			}
			next := copyObject(state)
			next["review"] = review
			if hasAgent {
				next["phase"] = "agent-working"
			} else if state["phase"] == "approved" {
				next["phase"] = "awaiting-review"
			}
			return next, true
		})
	})
}
func findOrNil(v any, key string, value any) Object {
	if v == nil {
		return nil
	}
	return find(v, key, value)
}
func (s *Store) Finish(id string, value any, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		input := request(value)
		kind := choice(input["kind"], "提交类型", "feedback", "approval")
		submissionID := newID()
		if present(input, "submissionId") {
			submissionID = requestID(input["submissionId"])
		}
		return s.update(id, view, func(state Object) (Object, bool) {
			history := objects(state["history"])
			review := obj(state["review"], "")
			if duplicate := find(state["history"], "id", submissionID); duplicate != nil {
				doc := obj(duplicate["review"], "")
				if history[len(history)-1]["id"] != submissionID || duplicate["kind"] != "logic-margin-"+kind || doc["revision"] != review["revision"] || obj(doc["snapshot"], "")["fingerprint"] != obj(review["snapshot"], "")["fingerprint"] {
					fail("提交标识已被其他轮次使用", 409)
				}
				return state, false
			}
			if !equal(input["expectedVersion"], state["version"]) {
				fail("会话已有更新，请核对最新批注后重新提交", 409)
			}
			if kind == "approval" && state["baselineReview"] == true && num(state["round"]) == 1 {
				fail("基线 B 用于提出改造要求，请提交意见后等待首个修改版本", 409)
			}
			if kind == "approval" && (state["phase"] == "agent-working" || state["phase"] == "feedback-ready") {
				fail("新版流程尚未发布，不能确认整轮通过", 409)
			}
			pending := pendingFeedback(review, history)
			if kind == "feedback" && len(pending) == 0 {
				fail("没有新的待处理意见可提交")
			}
			recordReview := review
			if kind == "feedback" {
				recordReview = copyObject(review)
				recordReview["comments"] = pending
			}
			record := createRecord(recordReview, kind)
			record["id"] = submissionID
			next := copyObject(state)
			records := append([]any{}, arr(state["history"], "")...)
			next["history"] = append(records, parseHistory([]any{record})...)
			if kind == "feedback" {
				next["phase"] = "feedback-ready"
			} else {
				next["phase"] = "approved"
			}
			return next, true
		})
	})
}
func (s *Store) Acknowledge(id string, value any, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		submissionID := requestID(request(value)["submissionId"])
		return s.update(id, view, func(state Object) (Object, bool) {
			history := objects(state["history"])
			if len(history) == 0 || history[len(history)-1]["id"] != submissionID || history[len(history)-1]["kind"] != "logic-margin-feedback" {
				fail("意见包已更新或不存在，请重新读取", 409)
			}
			if state["acknowledgedSubmission"] == submissionID {
				return state, false
			}
			latest := obj(history[len(history)-1]["review"], "")
			review := obj(state["review"], "")
			if state["phase"] != "feedback-ready" || latest["revision"] != review["revision"] || obj(latest["snapshot"], "")["fingerprint"] != obj(review["snapshot"], "")["fingerprint"] {
				fail("此意见包属于已结束的轮次，请读取当前轮次", 409)
			}
			next := copyObject(state)
			next["acknowledgedSubmission"] = submissionID
			next["phase"] = "agent-working"
			return next, true
		})
	})
}
func (s *Store) Revise(id string, value any, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		input := request(value)
		incoming := checkedReview(input["review"])
		return s.update(id, view, func(state Object) (Object, bool) {
			review := obj(state["review"], "")
			if !equal(input["expectedVersion"], state["version"]) {
				fail("会话已有更新，请读取最新意见后发布新版", 409)
			}
			if incoming["id"] != review["id"] {
				fail("只能发布相同评审 ID 的新版")
			}
			if !present(review, "baseline") && present(incoming, "baseline") {
				fail("请先补录固定基线，再发布新版", 409)
			}
			if present(review, "baseline") && present(incoming, "baseline") && !equal(review["baseline"], incoming["baseline"]) {
				fail("固定基线已存在，不能随新版替换", 409)
			}
			publication := validatePublication(input["publication"], incoming)
			if !equal(publication["baseRound"], state["round"]) {
				fail("发布基线不是当前固定流程，请重新读取本轮意见", 409)
			}
			if LogicIdentity(review) == LogicIdentity(incoming) && str(publication["unchangedReason"]) == "" {
				fail("流程没有逻辑变化，请说明流程未变的原因")
			}
			round := integer(num(state["round"])+1, "轮次")
			nextReview := rebaseReview(review, incoming)
			nextReview["comments"] = listMap(nextReview["comments"], func(c Object) Object {
				p := copyObject(c)
				original := find(review["comments"], "id", c["id"])
				if original == nil {
					p["originRound"] = round
					if present(c, "reviewedRound") {
						p["reviewedRound"] = round
					}
				}
				if present(c, "replies") {
					p["replies"] = listMap(c["replies"], func(reply Object) Object {
						if original != nil && findOrNil(original["replies"], "id", reply["id"]) != nil {
							return reply
						}
						r := copyObject(reply)
						r["round"] = round
						return r
					})
				}
				return p
			})
			if present(input, "replies") {
				a, ok := input["replies"].([]any)
				if !ok {
					if os, yes := input["replies"].([]Object); yes {
						for _, o := range os {
							a = append(a, o)
						}
					} else {
						fail("发布回应必须是数组")
					}
				}
				for _, v := range a {
					reply := request(v)
					cid := requestID(reply["commentId"])
					body, ok := reply["body"].(string)
					if !ok {
						fail("发布回应必须是文本")
					}
					if find(nextReview["comments"], "id", cid) == nil {
						fail("找不到此批注")
					}
					body = text(trim(body), "回复内容", 10000, true)
					nextReview["comments"] = listMap(nextReview["comments"], func(c Object) Object {
						if c["id"] != cid {
							return c
						}
						p := copyObject(c)
						replies := []any{}
						for _, r := range optionalObjects(c["replies"]) {
							replies = append(replies, r)
						}
						p["replies"] = append(replies, Object{"id": newID(), "author": "agent", "body": body, "createdAt": now(), "revision": nextReview["revision"], "round": round})
						p["status"] = "needs-review"
						return p
					})
				}
			}
			next := copyObject(state)
			next["review"] = nextReview
			next["round"] = round
			next["phase"] = "awaiting-review"
			snapshot := Object{"round": round, "openedAt": now(), "review": clone(nextReview), "publication": publication}
			history := objects(state["history"])
			if len(history) > 0 {
				snapshot["afterSubmission"] = history[len(history)-1]["id"]
			}
			snaps := append([]any{}, arr(state["snapshots"], "")...)
			next["snapshots"] = append(snaps, snapshot)
			return next, true
		})
	})
}
func removeIfExists(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
func (s *Store) Cleanup(id string, value any) (Object, error) {
	return captureIO(func() (Object, error) {
		input := request(value)
		mode := str(input["mode"])
		if mode != "archive" && mode != "delete" {
			fail("清理方式必须是归档或永久删除")
		}
		if present(input, "allowUnfinished") {
			if _, ok := input["allowUnfinished"].(bool); !ok {
				fail("未完成任务清理选项无效")
			}
		}
		e := s.acquire(id)
		defer s.release(id, e)
		state, err := s.load(id)
		var archive Object
		if err != nil {
			var se *Error
			if !errors.As(err, &se) || se.Status != 410 {
				return nil, err
			}
			archive, err = s.readArchive(id)
			if err != nil {
				return nil, err
			}
			state = obj(archive["session"], "")
		}
		if !equal(input["expectedVersion"], state["version"]) {
			fail("评审已有更新，请重新核对后再清理", 409)
		}
		if mode == "archive" && archive != nil {
			return Object{"id": id, "mode": mode, "archivedAt": archive["archivedAt"]}, nil
		}
		if state["phase"] != "approved" && input["allowUnfinished"] != true {
			fail("评审尚未通过；确认放弃后才能清理未完成任务", 409)
		}
		result := Object{"id": id, "mode": mode}
		if mode == "archive" {
			archivedAt := now()
			if err = os.MkdirAll(filepath.Join(s.dataDir, "archive"), 0700); err != nil {
				return nil, err
			}
			var b bytes.Buffer
			z := gzip.NewWriter(&b)
			if _, err = z.Write([]byte(stringify(Object{"archivedAt": archivedAt, "session": state}))); err != nil {
				return nil, err
			}
			if err = z.Close(); err != nil {
				return nil, err
			}
			if _, err = writeAtomic(s.archivePath(id), b.Bytes()); err != nil {
				return nil, err
			}
			if err = os.Remove(s.path(id)); err != nil {
				return nil, err
			}
			result["archivedAt"] = archivedAt
		} else {
			if err = removeIfExists(s.archivePath(id)); err != nil {
				return nil, err
			}
			if archive == nil {
				if err = os.Remove(s.path(id)); err != nil {
					return nil, err
				}
			}
		}
		s.forget(id)
		if mode == "archive" {
			s.notify(e, nil, &Error{"评审任务已归档，可从任务列表恢复", 410})
		} else {
			s.notify(e, nil, &Error{"评审任务已永久删除", 404})
		}
		return result, nil
	})
}
func (s *Store) Restore(id string, value any) (Object, error) {
	return captureIO(func() (Object, error) {
		input := request(value)
		e := s.acquire(id)
		defer s.release(id, e)
		archive, err := s.readArchive(id)
		if err != nil {
			return nil, err
		}
		state := obj(archive["session"], "")
		if !equal(input["expectedVersion"], state["version"]) {
			fail("归档版本已变化，请重新读取后恢复", 409)
		}
		if _, err = os.Stat(s.path(id)); err == nil {
			fail("已有同名活动任务，不能覆盖", 409)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		next := copyObject(state)
		next["version"] = integer(num(state["version"])+1, "版本")
		next["updatedAt"] = now()
		if err = s.persist(next, e); err != nil {
			return nil, err
		}
		if err = os.Remove(s.archivePath(id)); err != nil {
			return nil, err
		}
		return s.output(next, ""), nil
	})
}
