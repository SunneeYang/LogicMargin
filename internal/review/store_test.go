package review

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func must(t *testing.T) func(Object, error) Object {
	t.Helper()
	return func(o Object, e error) Object {
		t.Helper()
		if e != nil {
			t.Fatal(e)
		}
		return o
	}
}

func TestWriteFailureDoesNotPublishCachedStateOrNotifyWaiters(t *testing.T) {
	directory := t.TempDir()
	store := NewStore(directory)
	state := must(t)(store.Create(fixture(t), "", Object{}))
	id := str(state["id"])
	path := store.path(id)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(path, "preserve")
	if err := os.WriteFile(marker, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	next := clone(state).(Object)
	next["version"] = num(state["version"]) + 1
	entry := store.acquire(id)
	notification := entry.notice.done
	err = store.persist(next, entry)
	store.release(id, entry)
	if err == nil {
		t.Fatal("rename over nonempty directory unexpectedly succeeded")
	}
	select {
	case <-notification:
		t.Fatal("failed write notified a committed change")
	default:
	}
	store.mu.Lock()
	if item := store.cache[id]; item != nil && num(item.Value.(*cacheEntry).state["version"]) != num(state["version"]) {
		t.Fatal("cache moved ahead of failed disk write")
	}
	store.mu.Unlock()
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "preserve" {
		t.Fatal("failed write changed existing destination", err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatal("failed write leaked temporary file", entry.Name())
		}
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".saved", path); err != nil {
		t.Fatal(err)
	}
	restored := must(t)(store.Get(id, ""))
	if num(restored["version"]) != num(state["version"]) {
		t.Fatal("failed write survived recovery")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("original disk bytes changed", err)
	}
}
func fixture(t *testing.T) Object { return clone(oracle(t).Review).(Object) }
func firstComment(id string) Object {
	return Object{"id": id, "body": "意见", "targets": []any{Object{"kind": "node", "id": "check"}}, "status": "open", "createdAt": "2026-11-02T00:00:00Z", "revision": "v1"}
}
func batch(s Object, mutations ...Object) Object {
	r := obj(s["review"], "")
	return Object{"round": s["round"], "expectedVersion": s["version"], "revision": r["revision"], "fingerprint": obj(r["snapshot"], "")["fingerprint"], "mutations": mutations}
}
func add(s Object, id string) Object {
	return batch(s, Object{"kind": "add-comment", "comment": firstComment(id)})
}
func status(s Object, id, status string) Object {
	r := obj(s["review"], "")
	c := find(r["comments"], "id", id)
	return batch(s, Object{"kind": "set-status", "commentId": id, "from": c["status"], "status": status, "reviewedRevision": r["revision"]})
}
func sourceReview(t *testing.T, revision, code string) Object {
	r := fixture(t)
	r["revision"] = revision
	snap := obj(r["snapshot"], "")
	files := []Object{{"path": "logic.go", "sha256": hash(code + "\n")}}
	snap["files"] = files
	snap["fingerprint"] = hash(manifestJSON(files))
	objects(r["nodes"])[0]["evidence"] = []any{Object{"path": "logic.go", "symbol": "charge", "startLine": float64(1), "endLine": float64(1), "code": code, "digest": hash(code)}}
	return r
}
func publication(s, r Object) Object {
	snap := obj(r["snapshot"], "")
	return Object{"baseRound": s["round"], "summary": "修改实现", "unchangedReason": "核实流程不变", "source": Object{"algorithm": "sha256-path-content-v1", "checkedAt": "2026-11-02T00:00:00Z", "fingerprint": snap["fingerprint"], "files": snap["files"]}}
}
func publish(s, r Object) Object {
	return Object{"expectedVersion": s["version"], "review": r, "publication": publication(s, r)}
}
func assertStoreIdle(t *testing.T, s *Store) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.locks) != 0 {
		t.Fatalf("%d session locks remain", len(s.locks))
	}
	if len(s.cache) > maxCacheEntries || s.cacheBytes > maxCacheBytes {
		t.Fatalf("cache exceeds budget: %d entries, %d bytes", len(s.cache), s.cacheBytes)
	}
}
func TestConcurrentAppendRetriesAndConflicts(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	initial := get(s.Create(fixture(t), "", nil))
	id := str(initial["id"])
	const count = 48
	var wg sync.WaitGroup
	errs := make(chan error, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, e := s.Mutate(id, add(initial, fmt.Sprint(i)), ""); errs <- e }(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	saved := get(s.Get(id, ""))
	if len(objects(obj(saved["review"], "")["comments"])) != count || num(saved["version"]) != count+1 {
		t.Fatal("concurrent append lost data")
	}
	assertEqual(t, get(s.Mutate(id, add(initial, "0"), "")), saved)
	conflict := add(initial, "0")
	objects(conflict["mutations"])[0]["comment"].(Object)["body"] = "forged"
	_, err := s.Mutate(id, conflict, "")
	assertError(t, err, "相同批注标识的内容冲突", 409)
	atomic := batch(saved, Object{"kind": "add-comment", "comment": firstComment("rollback")}, Object{"kind": "unknown"})
	_, err = s.Mutate(id, atomic, "")
	assertError(t, err, "不支持此会话操作", 400)
	assertEqual(t, get(s.Get(id, "")), saved)
	changes := make(chan error, 2)
	for _, v := range []string{"resolved", "needs-review"} {
		go func(v string) { _, e := s.Mutate(id, status(saved, "0", v), ""); changes <- e }(v)
	}
	a, b := <-changes, <-changes
	if (a == nil) == (b == nil) {
		t.Fatalf("expected one version conflict, got %v, %v", a, b)
	}
	if a != nil {
		assertError(t, a, "批注已有更新，请查看最新回复后再确认状态", 409)
	}
	if b != nil {
		assertError(t, b, "批注已有更新，请查看最新回复后再确认状态", 409)
	}
	assertStoreIdle(t, s)
}
func TestFixedBaselineAndRoundOrigins(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	baseline := sourceReview(t, "v1", "chargeBeforeSuccess()")
	r := clone(baseline).(Object)
	r["baseline"] = baseline
	first := get(s.Create(r, "", Object{"baselineReview": true}))
	id := str(first["id"])
	_, err := s.Finish(id, Object{"kind": "approval", "expectedVersion": first["version"]}, "")
	assertError(t, err, "基线 B 用于提出改造要求，请提交意见后等待首个修改版本", 409)
	c := firstComment("baseline-comment")
	c["basis"] = "baseline"
	saved := get(s.Mutate(id, batch(first, Object{"kind": "add-comment", "comment": c}), ""))
	submitted := get(s.Finish(id, Object{"kind": "feedback", "expectedVersion": saved["version"], "submissionId": "feedback"}, ""))
	ack := get(s.Acknowledge(id, Object{"submissionId": "feedback"}, ""))
	assertEqual(t, get(s.Acknowledge(id, Object{"submissionId": "feedback"}, "")), ack)
	next := sourceReview(t, "v1", "chargeAfterSuccess()")
	next["nodes"] = []any{objects(next["nodes"])[1]}
	next["edges"] = []any{}
	published := get(s.Revise(id, publish(ack, next), ""))
	if num(published["round"]) != 2 {
		t.Fatal("round did not advance")
	}
	comment := objects(obj(published["review"], "")["comments"])[0]
	if comment["basis"] != "baseline" || num(comment["originRound"]) != 1 {
		t.Fatal("baseline origin moved")
	}
	assertEqual(t, get(s.GetBaseline(id))["review"], baseline)
	assertEqual(t, obj(get(s.GetRecord(id, "feedback"))["review"], "")["snapshot"], obj(submitted["review"], "")["snapshot"])
	assertEqual(t, get(s.GetSnapshot(id, 1))["review"], obj(first["snapshots"].([]any)[0], "")["review"])
	current := get(s.Get(id, "current"))
	if present(obj(current["review"], ""), "baseline") || present(obj(obj(current["baseline"], "")["snapshot"], ""), "files") || len(objects(current["commentOrigins"])) != 0 {
		t.Fatal("invalid current baseline projection")
	}
	restored := get(NewStore(s.dataDir).Get(id, ""))
	assertEqual(t, restored, published)
	resolved := get(s.Mutate(id, status(published, "baseline-comment", "resolved"), ""))
	approved := get(s.Finish(id, Object{"kind": "approval", "expectedVersion": resolved["version"]}, ""))
	if approved["phase"] != "approved" {
		t.Fatal("approval failed")
	}
	assertStoreIdle(t, s)
}
func TestBaselineAttachmentAndSessionIsolation(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	r := fixture(t)
	r["comments"] = []any{firstComment("old")}
	first := get(s.Create(r, "current", Object{"scope": Object{"context": "thread", "purpose": "first"}, "cleanupPolicy": "archive-on-approval"}))
	second := get(s.Create(r, "", Object{"scope": Object{"context": "thread", "purpose": "second"}}))
	if len(objects(obj(first["review"], "")["comments"])) != 0 || len(objects(obj(second["review"], "")["comments"])) != 0 {
		t.Fatal("scoped session retained unrelated comments")
	}
	id := str(first["id"])
	baseline := fixture(t)
	attached := get(s.AttachBaseline(id, Object{"expectedVersion": first["version"], "baseline": baseline}, ""))
	if attached["round"] != first["round"] {
		t.Fatal("attachment advanced round")
	}
	assertEqual(t, get(s.AttachBaseline(id, Object{"expectedVersion": first["version"], "baseline": baseline}, "")), attached)
	other := clone(baseline).(Object)
	other["revision"] = "other"
	_, err := s.AttachBaseline(id, Object{"expectedVersion": attached["version"], "baseline": other}, "")
	assertError(t, err, "固定基线已存在，不能替换", 409)
	list := get(s.List(Object{"context": "thread"}))
	if len(objects(list["sessions"])) != 2 {
		t.Fatal("context filtering lost sessions")
	}
	assertEqual(t, get(s.Get(str(second["id"]), "")), second)
	// The archive policy is consumed by CLI/agent after delivery, never by Finish.
	approved := get(s.Finish(id, Object{"kind": "approval", "expectedVersion": attached["version"]}, ""))
	if _, err = os.Stat(s.path(id)); err != nil {
		t.Fatal("approval prematurely archived", err)
	}
	archived := get(s.Cleanup(id, Object{"expectedVersion": approved["version"], "mode": "archive"}))
	if !present(archived, "archivedAt") {
		t.Fatal("missing archive metadata")
	}
	assertStoreIdle(t, s)
}
func TestWaitChangeCancelCloseAndCleanup(t *testing.T) {
	get := must(t)
	s := NewStore(t.TempDir())
	first := get(s.Create(fixture(t), "", nil))
	id := str(first["id"])
	version := int(num(first["version"]))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := s.WaitForChange(ctx, id, version, time.Second, "")
	if err != nil || result != nil {
		t.Fatalf("cancel returned %v %v", result, err)
	}
	result, err = s.WaitForChange(context.Background(), id, version, time.Millisecond, "")
	if err != nil || result != nil {
		t.Fatal("timeout", err)
	}
	assertStoreIdle(t, s)
	type response struct {
		state Object
		err   error
	}
	ch := make(chan response, 1)
	go func() {
		r, e := s.WaitForChange(context.Background(), id, version, time.Second, "current")
		ch <- response{r, e}
	}()
	saved := get(s.Mutate(id, add(first, "c"), ""))
	waited := <-ch
	if waited.err != nil {
		t.Fatal(waited.err)
	}
	assertEqual(t, waited.state, get(s.Get(id, "current")))
	go func() {
		r, e := s.WaitForChange(context.Background(), id, int(num(saved["version"])), time.Second, "")
		ch <- response{r, e}
	}()
	get(s.Cleanup(id, Object{"expectedVersion": saved["version"], "mode": "archive", "allowUnfinished": true}))
	waited = <-ch
	assertError(t, waited.err, "评审任务已归档，可从任务列表恢复", 410)
	get(s.Restore(id, Object{"expectedVersion": saved["version"]}))
	current := get(s.Get(id, ""))
	go func() {
		r, e := s.WaitForChange(context.Background(), id, int(num(current["version"])), time.Second, "")
		ch <- response{r, e}
	}()
	s.Close()
	s.Close()
	waited = <-ch
	assertError(t, waited.err, "评审服务已停止", 503)
	assertStoreIdle(t, s)
}
func TestCacheExternalChangesAndBoundedEntries(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	created := get(s.Create(fixture(t), "", nil))
	id := str(created["id"])
	file := s.path(id)
	before, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	edited := clone(created).(Object)
	obj(edited["review"], "")["title"] = "new title"
	if err = os.WriteFile(file, []byte(stringify(edited)), 0600); err != nil {
		t.Fatal(err)
	}
	assertEqual(t, get(s.Get(id, "")), edited)
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	broken := bytes.Repeat([]byte("x"), len(raw))
	if err = os.WriteFile(file, broken, 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(file, before.ModTime(), before.ModTime())
	_, err = s.Get(id, "")
	var se *Error
	if !errors.As(err, &se) || se.Status != 500 || !strings.Contains(se.Message, "原文件已保留") {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(file)
	if !bytes.Equal(after, broken) {
		t.Fatal("corrupt original overwritten")
	}
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	_, err = s.Get(id, "")
	assertError(t, err, "找不到审查任务，可能已被清理", 404)
	var last Object
	for i := 0; i < 20; i++ {
		last = get(s.Create(fixture(t), "current", nil))
	}
	assertStoreIdle(t, s)
	expectedEntries := 16
	metadata, err := os.Stat(s.path(str(last["id"])))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := changeTime(metadata); !ok {
		expectedEntries = 0
	}
	s.mu.Lock()
	if len(s.cache) != expectedEntries {
		t.Fatal("cache entry limit", len(s.cache))
	}
	s.mu.Unlock()
}
func TestOldGzipArchiveAndDamagedList(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	defer s.Close()
	get := must(t)
	raw, e := os.ReadFile("testdata/legacy-session.json.gz")
	if e != nil {
		t.Fatal(e)
	}
	z, e := gzip.NewReader(bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	uncompressed, e := io.ReadAll(z)
	if e != nil {
		t.Fatal(e)
	}
	_ = z.Close()
	var archived Object
	if e = json.Unmarshal(uncompressed, &archived); e != nil {
		t.Fatal(e)
	}
	id := str(obj(archived["session"], "")["id"])
	if e = os.MkdirAll(filepath.Join(dir, "archive"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(s.archivePath(id), raw, 0600); e != nil {
		t.Fatal(e)
	}
	assertEqual(t, get(s.GetArchive(id)), archived["session"])
	list := get(s.List(Object{"state": "archived"}))
	if len(objects(list["sessions"])) != 1 {
		t.Fatal("old archive not listed")
	}
	restored := get(s.Restore(id, Object{"expectedVersion": obj(archived["session"], "")["version"]}))
	if num(restored["version"]) != num(obj(archived["session"], "")["version"])+1 {
		t.Fatal("restore version")
	}
	get(s.Cleanup(id, Object{"expectedVersion": restored["version"], "mode": "archive"}))
	if _, e = os.Stat(s.path(id)); !os.IsNotExist(e) {
		t.Fatal("active file retained", e)
	}
	broken := get(s.Create(fixture(t), "", nil))
	if e = os.WriteFile(s.path(str(broken["id"])), []byte("broken active"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(s.archivePath(id), []byte("broken archive"), 0600); e != nil {
		t.Fatal(e)
	}
	healthy := get(s.Create(fixture(t), "", Object{"scope": Object{"context": "healthy", "purpose": "continue"}}))
	list = get(s.List(Object{"state": "all", "context": "healthy"}))
	if len(objects(list["sessions"])) != 1 || len(arr(list["warnings"], "")) != 2 {
		t.Fatal("damaged tasks blocked healthy listing", list)
	}
	assertEqual(t, objects(list["sessions"])[0]["id"], healthy["id"])
	content, _ := os.ReadFile(s.path(str(broken["id"])))
	if string(content) != "broken active" {
		t.Fatal("damaged task changed")
	}
	assertStoreIdle(t, s)
}

func TestUnboundedHistoryAndCorruptionGuards(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	created := get(s.Create(fixture(t), "", nil))
	id := str(created["id"])
	seed := clone(created).(Object)
	seed["round"] = float64(60)
	seed["snapshots"] = []any{}
	seed["history"] = []any{}
	for i := 0; i < 60; i++ {
		seed["snapshots"] = append(seed["snapshots"].([]any), Object{"round": float64(i + 1), "openedAt": created["createdAt"], "review": created["review"]})
		record := createRecord(obj(created["review"], ""), "approval")
		seed["history"] = append(seed["history"].([]any), record)
	}
	if err := os.WriteFile(s.path(id), []byte(stringify(seed)), 0600); err != nil {
		t.Fatal(err)
	}
	loaded := get(s.Get(id, ""))
	approved := get(s.Finish(id, Object{"expectedVersion": loaded["version"], "kind": "approval"}, ""))
	if len(objects(approved["history"])) != 61 || len(objects(approved["snapshots"])) != 60 {
		t.Fatal("history truncated")
	}
	broken := clone(approved).(Object)
	c := firstComment("future")
	c["originRound"] = float64(61)
	obj(broken["review"], "")["comments"] = []any{c}
	raw := []byte(stringify(broken))
	if err := os.WriteFile(s.path(id), raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get(id, "")
	assertError(t, err, "会话文件损坏，原文件已保留：批注所属轮次超出流程版本", 500)
	after, _ := os.ReadFile(s.path(id))
	if !bytes.Equal(raw, after) {
		t.Fatal("damaged original overwritten")
	}
	if err = os.WriteFile(s.path(id), []byte(stringify(approved)), 0600); err != nil {
		t.Fatal(err)
	}
	// An uncommittable archive must leave the active session and remove its temp file.
	if err = os.MkdirAll(s.archivePath(id), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Cleanup(id, Object{"mode": "archive", "expectedVersion": approved["version"]}); err == nil {
		t.Fatal("archive unexpectedly succeeded")
	}
	assertEqual(t, get(s.Get(id, "")), approved)
	entries, err := os.ReadDir(filepath.Dir(s.archivePath(id)))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatal("archive temporary leaked")
		}
	}
	assertStoreIdle(t, s)
}
func TestWaitersReleaseAllLocks(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	created := get(s.Create(fixture(t), "", nil))
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := s.WaitForChange(ctx, str(created["id"]), 1, time.Second, "current")
			if err != nil || result != nil {
				t.Errorf("cancel = %v %v", result, err)
			}
		}()
	}
	cancel()
	wg.Wait()
	assertStoreIdle(t, s)
	assertEqual(t, get(s.Get(str(created["id"]), "")), created)
	metadata, err := os.Stat(s.path(str(created["id"])))
	if err != nil {
		t.Fatal(err)
	}
	s.remember(created, metadata, maxCacheBytes+1)
	s.mu.Lock()
	if len(s.cache) != 0 || s.cacheBytes != 0 {
		t.Fatal("oversized item retained")
	}
	s.mu.Unlock()
}

func TestBaselineAndRecordReadsReturnDefensiveCopies(t *testing.T) {
	s := NewStore(t.TempDir())
	defer s.Close()
	get := must(t)
	r := fixture(t)
	r["baseline"] = fixture(t)
	state := get(s.Create(r, "", Object{}))
	id := str(state["id"])
	baseline := get(s.GetBaseline(id))
	obj(baseline["review"], "")["title"] = "caller changed baseline"
	assertEqual(t, get(s.GetBaseline(id))["review"], r["baseline"])
	state = get(s.Finish(id, Object{"kind": "approval", "expectedVersion": state["version"]}, ""))
	record := objects(state["history"])[0]
	returned := get(s.GetRecord(id, str(record["id"])))
	obj(returned["review"], "")["title"] = "caller changed record"
	assertEqual(t, get(s.GetRecord(id, str(record["id"]))), record)
}

func TestGrowingHistoryCrosses32MiBAndSurvivesRestart(t *testing.T) {
	directory := t.TempDir()
	store := NewStore(directory)
	defer store.Close()
	get := must(t)
	state := get(store.Create(fixture(t), "", nil))
	doc := obj(state["review"], "")
	comments := []any{}
	for i := 0; i < 110; i++ {
		c := firstComment(fmt.Sprintf("size-%d", i))
		c["originRound"] = float64(1)
		c["body"] = "x"
		comments = append(comments, c)
	}
	doc["comments"] = comments
	state["round"] = float64(30)
	snapshots := []any{}
	docs := []Object{doc}
	for i := 0; i < 30; i++ {
		snapshotDoc := clone(doc).(Object)
		docs = append(docs, snapshotDoc)
		snapshots = append(snapshots, Object{"round": float64(i + 1), "openedAt": state["createdAt"], "review": snapshotDoc})
	}
	state["snapshots"] = snapshots
	const target = 32*1024*1024 - 1000
	bodyLength := 1 + (target-len(stringify(state)))/(len(docs)*len(comments))
	for _, d := range docs {
		for _, c := range objects(d["comments"]) {
			c["body"] = strings.Repeat("x", bodyLength)
		}
	}
	remaining := target - len(stringify(state))
	for _, c := range objects(doc["comments"]) {
		extra := min(remaining, 10000-len(str(c["body"])))
		c["body"] = str(c["body"]) + strings.Repeat("x", extra)
		remaining -= extra
	}
	raw := []byte(stringify(state))
	if remaining != 0 || len(raw) != target {
		t.Fatal("invalid size fixture", remaining, len(raw))
	}
	id := str(state["id"])
	if err := os.WriteFile(store.path(id), raw, 0600); err != nil {
		t.Fatal(err)
	}
	before := get(store.Get(id, "current"))
	added := firstComment("size-new")
	added["body"] = strings.Repeat("x", 10000)
	saved := get(store.Mutate(id, Object{"round": float64(30), "revision": doc["revision"], "fingerprint": obj(doc["snapshot"], "")["fingerprint"], "mutations": []any{Object{"kind": "add-comment", "comment": added}}}, "current"))
	if num(saved["version"]) != num(before["version"])+1 || len(objects(obj(saved["review"], "")["comments"])) != 111 {
		t.Fatal("history growth lost data")
	}
	info, err := os.Stat(store.path(id))
	if err != nil || info.Size() <= 32*1024*1024 {
		t.Fatal("did not cross former limit", info, err)
	}
	restarted := NewStore(directory)
	defer restarted.Close()
	assertEqual(t, get(restarted.Get(id, "current")), saved)
}
