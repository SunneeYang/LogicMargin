package review

import (
	"strings"
	"testing"
)

func discussionReply(commentID, replyID, author string) Object {
	return Object{"kind": "add-reply", "commentId": commentID, "reply": Object{
		"id": replyID, "author": author, "body": "补充", "createdAt": "2026-11-02T00:00:01Z", "revision": "v1",
	}}
}

func editDiscussion(commentID, replyID, from, body string) Object {
	m := Object{"kind": "edit-comment", "commentId": commentID, "from": from, "body": body}
	if replyID != "" {
		m["kind"], m["replyId"] = "edit-reply", replyID
	}
	return m
}

func TestDiscussionEditsPersistInPlaceAndKeepProjection(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	state := get(s.Create(fixture(t), "", nil))
	id := str(state["id"])
	state = get(s.Mutate(id, batch(state,
		Object{"kind": "add-comment", "comment": firstComment("first")},
		Object{"kind": "add-comment", "comment": firstComment("second")},
		discussionReply("first", "reply", "reviewer")), ""))
	before := clone(state).(Object)
	state = get(s.Mutate(id, batch(state, editDiscussion("first", "", "意见", "  修改意见 😀 \n")), ""))
	state = get(s.Mutate(id, batch(state, editDiscussion("first", "reply", "补充", " 修改补充 ")), ""))
	expected := clone(before).(Object)
	expected["version"], expected["updatedAt"] = state["version"], state["updatedAt"]
	comment := find(obj(expected["review"], "")["comments"], "id", "first")
	comment["body"] = "修改意见 😀"
	objects(comment["replies"])[0]["body"] = "修改补充"
	assertEqual(t, state, expected)
	if num(state["version"]) != num(before["version"])+2 {
		t.Fatal("edits did not increment version once each")
	}
	projection := obj(get(s.Get(id, "current"))["editableDiscussion"], "")
	assertEqual(t, projection, Object{"comments": []any{"first", "second"}, "replies": []any{Object{"commentId": "first", "replyId": "reply"}}})
	reopened := NewStore(s.dataDir)
	defer reopened.Close()
	assertEqual(t, get(reopened.Get(id, "")), state)
	assertEqual(t, get(s.Mutate(id, batch(state, editDiscussion("first", "", "修改意见 😀", "修改意见 😀")), "")), state)
}

func TestSubmittedDiscussionBodiesFreezeButNewRepliesRemainEditable(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	state := get(s.Create(fixture(t), "", nil))
	id := str(state["id"])
	state = get(s.Mutate(id, batch(state, Object{"kind": "add-comment", "comment": firstComment("first")}, discussionReply("first", "same-id", "reviewer")), ""))
	state = get(s.Finish(id, Object{"kind": "feedback", "expectedVersion": state["version"], "submissionId": "fixed"}, ""))
	frozen := get(s.GetRecord(id, "fixed"))
	for _, edit := range []Object{editDiscussion("first", "", "意见", "替换"), editDiscussion("first", "same-id", "补充", "替换")} {
		_, err := s.Mutate(id, batch(state, edit), "")
		assertError(t, err, "只能修改本轮尚未提交的讨论", 409)
	}
	state = get(s.Mutate(id, batch(state,
		discussionReply("first", "new-reply", "reviewer"),
		discussionReply("first", "agent-reply", "agent"),
		Object{"kind": "add-comment", "comment": firstComment("second")},
		discussionReply("second", "same-id", "reviewer")), ""))
	projection := obj(get(s.Get(id, "current"))["editableDiscussion"], "")
	assertEqual(t, projection, Object{"comments": []any{"second"}, "replies": []any{
		Object{"commentId": "first", "replyId": "new-reply"}, Object{"commentId": "second", "replyId": "same-id"},
	}})
	state = get(s.Mutate(id, batch(state, editDiscussion("first", "new-reply", "补充", "新补充已修正"), editDiscussion("second", "same-id", "补充", "同名回复独立修改")), ""))
	_, err := s.Mutate(id, batch(state, editDiscussion("first", "agent-reply", "补充", "伪造代理回应")), "")
	assertError(t, err, "只能修改本轮尚未提交的讨论", 409)
	assertEqual(t, get(s.GetRecord(id, "fixed")), frozen)
}

func TestDiscussionEditsRejectPriorRoundAndAmbiguousLegacyProvenance(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	state := get(s.Create(sourceReview(t, "v1", "check()"), "", nil))
	id := str(state["id"])
	state = get(s.Mutate(id, batch(state, Object{"kind": "add-comment", "comment": firstComment("first")}, discussionReply("first", "reply", "reviewer")), ""))
	roundOne := clone(state).(Object)
	state = get(s.Revise(id, publish(state, sourceReview(t, "v1", "check()")), ""))
	for _, edit := range []Object{editDiscussion("first", "", "意见", "旧意见"), editDiscussion("first", "reply", "补充", "旧补充")} {
		_, err := s.Mutate(id, batch(state, edit), "")
		assertError(t, err, "只能修改本轮尚未提交的讨论", 409)
	}
	projection := obj(get(s.Get(id, "current"))["editableDiscussion"], "")
	assertEqual(t, projection, Object{"comments": []any{}, "replies": []any{}})
	legacy := clone(state).(Object)
	c := objects(obj(legacy["review"], "")["comments"])[0]
	delete(c, "originRound")
	delete(objects(c["replies"])[0], "round")
	comments, replies := discussionEditPermissions(legacy, obj(legacy["review"], ""))
	if comments["first"] || replies[stringify([]any{"first", "reply"})] {
		t.Fatal("ambiguous legacy content became editable")
	}
	legacy = roundOne
	c = objects(obj(legacy["review"], "")["comments"])[0]
	delete(c, "originRound")
	delete(objects(c["replies"])[0], "round")
	comments, replies = discussionEditPermissions(legacy, obj(legacy["review"], ""))
	if !comments["first"] || !replies[stringify([]any{"first", "reply"})] {
		t.Fatal("round-one legacy content lost its clear origin")
	}
	state = get(s.Mutate(id, batch(state, discussionReply("first", "current-reply", "reviewer")), ""))
	state = get(s.Mutate(id, batch(state, editDiscussion("first", "current-reply", "补充", "本轮补充修改")), ""))
	assertEqual(t, obj(get(s.Get(id, "current"))["editableDiscussion"], ""), Object{"comments": []any{}, "replies": []any{
		Object{"commentId": "first", "replyId": "current-reply"},
	}})
}

func TestDiscussionEditGuardsRejectStaleAndInvalidWritesAtomically(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	state := get(s.Create(fixture(t), "", nil))
	id := str(state["id"])
	state = get(s.Mutate(id, add(state, "first"), ""))
	for _, version := range []any{nil, float64(1)} {
		request := batch(state, editDiscussion("first", "", "意见", "更新"))
		request["expectedVersion"] = version
		_, err := s.Mutate(id, request, "")
		if version == nil {
			assertError(t, err, "版本无效", 400)
		} else {
			assertError(t, err, "讨论已有更新，请读取最新内容后重试", 409)
		}
	}
	for _, tc := range []struct {
		mutation Object
		message  string
		status   int
	}{
		{editDiscussion("first", "", "过期意见", "更新"), "讨论内容已有变化，请核对最新内容", 409},
		{editDiscussion("missing", "", "意见", "更新"), "找不到此批注", 404},
		{editDiscussion("first", "missing", "意见", "更新"), "找不到此回复", 404},
		{editDiscussion("first", "", "意见", " \n\t"), "批注内容必须是非空文本，最多 10000 字符", 400},
		{editDiscussion("first", "", "意见", strings.Repeat("😀", 5001)), "批注内容必须是非空文本，最多 10000 字符", 400},
		{editDiscussion("first", "", "意见", string([]byte{0xff})), "JSON 必须是有效 UTF-8 文本", 400},
		{Object{"kind": "edit-comment", "commentId": "first", "from": "意见", "body": true}, "批注内容必须是非空文本，最多 10000 字符", 400},
		{Object{"kind": "edit-comment", "commentId": "first", "from": "意见", "body": "更新", "targets": []any{}}, "编辑讨论只能修改正文", 400},
	} {
		_, err := s.Mutate(id, batch(state, tc.mutation), "")
		assertError(t, err, tc.message, tc.status)
		assertEqual(t, get(s.Get(id, "")), state)
	}
	_, err := s.Mutate(id, batch(state, editDiscussion("first", "", "意见", "更新"), Object{"kind": "unknown"}), "")
	assertError(t, err, "不支持此会话操作", 400)
	assertEqual(t, get(s.Get(id, "")), state)
	for _, key := range []string{"revision", "fingerprint", "round"} {
		request := batch(state, editDiscussion("first", "", "意见", "更新"))
		if key == "round" {
			request[key] = float64(2)
		} else {
			request[key] = "stale"
		}
		_, err := s.Mutate(id, request, "")
		if err == nil {
			t.Fatalf("edit accepted stale %s", key)
		}
		assertEqual(t, get(s.Get(id, "")), state)
	}
}

func TestBaselineAndApprovalDiscussionEditBoundaries(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	r := fixture(t)
	r["baseline"] = clone(r)
	state := get(s.Create(r, "", nil))
	id := str(state["id"])
	c := firstComment("baseline")
	c["basis"] = "baseline"
	state = get(s.Mutate(id, batch(state, Object{"kind": "add-comment", "comment": c}, editDiscussion("baseline", "", "意见", "基线修改")), ""))
	assertEqual(t, obj(get(s.Get(id, "current"))["editableDiscussion"], "")["comments"], []any{"baseline"})
	state = get(s.Mutate(id, status(state, "baseline", "resolved"), ""))
	state = get(s.Finish(id, Object{"kind": "approval", "expectedVersion": state["version"], "submissionId": "approved"}, ""))
	frozen := get(s.GetRecord(id, "approved"))
	_, err := s.Mutate(id, batch(state, editDiscussion("baseline", "", "基线修改", "不能改通过记录")), "")
	assertError(t, err, "只能修改本轮尚未提交的讨论", 409)
	assertEqual(t, get(s.GetRecord(id, "approved")), frozen)
}

func TestDiscussionEditLostAcknowledgementRetriesAreHarmless(t *testing.T) {
	for _, replyID := range []string{"", "reply"} {
		t.Run("reply-"+replyID, func(t *testing.T) {
			s := NewStore(t.TempDir())
			defer s.Close()
			get := must(t)
			state := get(s.Create(fixture(t), "", nil))
			id := str(state["id"])
			state = get(s.Mutate(id, batch(state, Object{"kind": "add-comment", "comment": firstComment("first")}, discussionReply("first", "reply", "reviewer")), ""))
			from := "意见"
			if replyID != "" {
				from = "补充"
			}
			request := batch(state, editDiscussion("first", replyID, from, "  已修改  "))
			state = get(s.Mutate(id, request, ""))
			state = get(s.Mutate(id, add(state, "second"), ""))
			assertEqual(t, get(s.Mutate(id, request, "")), state)
			fresh := batch(state, editDiscussion("first", replyID, from, "已修改"))
			assertEqual(t, get(s.Mutate(id, fresh, "")), state)
			_, err := s.Mutate(id, batch(state, editDiscussion("first", replyID, from, "不同正文")), "")
			assertError(t, err, "讨论内容已有变化，请核对最新内容", 409)
			staleChange := batch(state, editDiscussion("first", replyID, "已修改", "不同正文"))
			staleChange["expectedVersion"] = request["expectedVersion"]
			_, err = s.Mutate(id, staleChange, "")
			assertError(t, err, "讨论已有更新，请读取最新内容后重试", 409)
			mixed := batch(state, editDiscussion("first", replyID, from, "已修改"), editDiscussion("second", "", "意见", "另一项修改"))
			mixed["expectedVersion"] = request["expectedVersion"]
			_, err = s.Mutate(id, mixed, "")
			assertError(t, err, "讨论已有更新，请读取最新内容后重试", 409)
			assertEqual(t, get(s.Get(id, "")), state)
			state = get(s.Finish(id, Object{"kind": "feedback", "expectedVersion": state["version"], "submissionId": "fixed"}, ""))
			frozen := get(s.GetRecord(id, "fixed"))
			_, err = s.Mutate(id, request, "")
			assertError(t, err, "只能修改本轮尚未提交的讨论", 409)
			assertEqual(t, get(s.GetRecord(id, "fixed")), frozen)
			assertEqual(t, get(s.Get(id, "")), state)
		})
	}
}

func TestDiscussionEditNoopStillValidatesItsPayload(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	state := get(s.Create(fixture(t), "", nil))
	id := str(state["id"])
	state = get(s.Mutate(id, add(state, "first"), ""))
	for _, version := range []any{nil, "1", float64(0), 1.5} {
		request := batch(state, editDiscussion("first", "", "过期正文", "意见"))
		request["expectedVersion"] = version
		_, err := s.Mutate(id, request, "")
		assertError(t, err, "版本无效", 400)
	}
	for _, from := range []any{nil, true, "", strings.Repeat("a", 10001), string([]byte{0xff})} {
		mutation := editDiscussion("first", "", "", "意见")
		mutation["from"] = from
		_, err := s.Mutate(id, batch(state, mutation), "")
		if err == nil {
			t.Fatal("invalid from accepted as no-op")
		}
	}
	for _, key := range []string{"revision", "fingerprint", "round"} {
		request := batch(state, editDiscussion("first", "", "过期正文", "意见"))
		request[key] = "stale"
		_, err := s.Mutate(id, request, "")
		if err == nil {
			t.Fatalf("no-op accepted stale %s", key)
		}
	}
	forged := editDiscussion("first", "", "过期正文", "意见")
	forged["targets"] = []any{}
	_, err := s.Mutate(id, batch(state, forged), "")
	assertError(t, err, "编辑讨论只能修改正文", 400)
	assertEqual(t, get(s.Get(id, "")), state)
}
