package review

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxCacheBytes = 64 * 1024 * 1024
const maxCacheEntries = 16

var sessionPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var activePattern = regexp.MustCompile(`^[a-f0-9-]{36}\.json$`)
var archivePattern = regexp.MustCompile(`^[a-f0-9-]{36}\.json\.gz$`)

func sessionID(s string) string {
	if !sessionPattern.MatchString(s) {
		fail("会话标识无效")
	}
	return s
}
func requestID(v any) string {
	s, ok := v.(string)
	if !ok || trim(s) == "" || utfLength(s) > 200 {
		fail("标识无效")
	}
	return s
}
func integer(v any, label string) float64 { return positive(v, label+"无效") }
func commentRounds(r Object, round float64) {
	for _, c := range objects(r["comments"]) {
		for _, key := range []string{"originRound", "reviewedRound"} {
			if present(c, key) && num(c[key]) > round {
				fail("批注所属轮次超出流程版本")
			}
		}
		for _, reply := range optionalObjects(c["replies"]) {
			if present(reply, "round") && num(reply["round"]) > round {
				fail("批注所属轮次超出流程版本")
			}
		}
	}
}
func parseSession(v any) Object {
	s := request(v)
	if num(s["schemaVersion"]) != 1 {
		fail("会话格式无效")
	}
	phase := str(s["phase"])
	if phase != "awaiting-review" && phase != "feedback-ready" && phase != "agent-working" && phase != "approved" {
		fail("会话格式无效")
	}
	review := checkedReview(s["review"])
	options := parseOptions(s)
	if options["baselineReview"] == true && !present(review, "baseline") {
		fail("基线改造评审缺少固定基线 B")
	}
	history := parseHistory(s["history"])
	for _, r := range objects(history) {
		validateEvidenceCode(obj(r["review"], ""))
	}
	raw, ok := s["snapshots"].([]any)
	if !ok || len(raw) == 0 {
		fail("会话快照无效")
	}
	snapshots := []any{}
	for _, v := range raw {
		sn := request(v)
		after := ""
		if present(sn, "afterSubmission") {
			after = requestID(sn["afterSubmission"])
			if find(history, "id", after) == nil {
				fail("轮次起点记录不存在")
			}
		}
		round := integer(sn["round"], "轮次")
		r := checkedReview(sn["review"])
		commentRounds(r, round)
		var publication Object
		if present(sn, "publication") {
			publication = validatePublication(sn["publication"], r)
			if num(publication["baseRound"]) >= round {
				fail("发布基线必须指向更早的流程快照")
			}
		}
		parsed := Object{"round": round, "openedAt": sessionDate(sn["openedAt"]), "review": r}
		if after != "" {
			parsed["afterSubmission"] = after
		}
		if publication != nil {
			parsed["publication"] = publication
		}
		snapshots = append(snapshots, parsed)
	}
	round := integer(s["round"], "轮次")
	commentRounds(review, round)
	if float64(len(snapshots)) != round {
		fail("会话历史所属评审或轮次不一致")
	}
	for i, sn := range objects(snapshots) {
		if num(sn["round"]) != float64(i+1) || obj(sn["review"], "")["id"] != review["id"] {
			fail("会话历史所属评审或轮次不一致")
		}
	}
	for _, r := range objects(history) {
		if obj(r["review"], "")["id"] != review["id"] {
			fail("会话历史所属评审或轮次不一致")
		}
	}
	for _, a := range [][]Object{objects(snapshots), objects(history)} {
		for _, item := range a {
			r := obj(item["review"], "")
			if present(r, "baseline") && (!present(review, "baseline") || !equal(r["baseline"], review["baseline"])) {
				fail("会话历史中的固定基线不一致")
			}
		}
	}
	ack := ""
	if present(s, "acknowledgedSubmission") {
		ack = requestID(s["acknowledgedSubmission"])
		record := find(history, "id", ack)
		if record == nil || record["kind"] != "logic-margin-feedback" {
			fail("会话接收记录不存在")
		}
	}
	out := Object{"schemaVersion": float64(1), "id": sessionID(str(s["id"])), "version": integer(s["version"], "版本"), "round": round, "phase": phase, "createdAt": sessionDate(s["createdAt"]), "updatedAt": sessionDate(s["updatedAt"]), "review": review, "history": history, "snapshots": snapshots}
	for k, v := range options {
		out[k] = v
	}
	if ack != "" {
		out["acknowledgedSubmission"] = ack
	}
	return out
}

type notice struct {
	done  chan struct{}
	state Object
	err   error
}
type sessionLock struct {
	mu     sync.Mutex
	refs   int
	notice *notice
}
type cacheEntry struct {
	id             string
	state, current Object
	metadata       os.FileInfo
	bytes          int
}

// shortcut: one service owns this directory; use a database before enabling multiple writers.
type Store struct {
	dataDir    string
	mu         sync.Mutex
	locks      map[string]*sessionLock
	cache      map[string]*list.Element
	lru        *list.List
	cacheBytes int
	closed     chan struct{}
	once       sync.Once
}

func NewStore(dataDir string) *Store {
	if dataDir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			panic(err)
		}
		dataDir = filepath.Join(cwd, ".logic-margin", "sessions")
	}
	return &Store{dataDir: dataDir, locks: map[string]*sessionLock{}, cache: map[string]*list.Element{}, lru: list.New(), closed: make(chan struct{})}
}
func (s *Store) acquire(id string) *sessionLock {
	sessionID(id)
	s.mu.Lock()
	e := s.locks[id]
	if e == nil {
		e = &sessionLock{notice: &notice{done: make(chan struct{})}}
		s.locks[id] = e
	}
	e.refs++
	s.mu.Unlock()
	e.mu.Lock()
	return e
}
func (s *Store) release(id string, e *sessionLock) { e.mu.Unlock(); s.unref(id, e) }
func (s *Store) unref(id string, e *sessionLock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e.refs--
	if e.refs == 0 {
		delete(s.locks, id)
	}
}
func (s *Store) path(id string) string { return filepath.Join(s.dataDir, sessionID(id)+".json") }
func (s *Store) archivePath(id string) string {
	return filepath.Join(s.dataDir, "archive", sessionID(id)+".json.gz")
}
func (s *Store) forgetLocked(id string) {
	if e := s.cache[id]; e != nil {
		s.cacheBytes -= e.Value.(*cacheEntry).bytes
		s.lru.Remove(e)
		delete(s.cache, id)
	}
}
func (s *Store) forget(id string) { s.mu.Lock(); defer s.mu.Unlock(); s.forgetLocked(id) }
func changeTime(info os.FileInfo) (any, bool) {
	metadata := reflect.Indirect(reflect.ValueOf(info.Sys()))
	if !metadata.IsValid() || metadata.Kind() != reflect.Struct {
		return nil, false
	}
	for _, name := range []string{"Ctim", "Ctimespec", "Ctime"} {
		if field := metadata.FieldByName(name); field.IsValid() && field.CanInterface() {
			if nanos := metadata.FieldByName("Ctimensec"); nanos.IsValid() && nanos.CanInterface() {
				return [2]any{field.Interface(), nanos.Interface()}, true
			}
			return field.Interface(), true
		}
	}
	return nil, false
}
func sameSignature(a, b os.FileInfo) bool {
	if a == nil || b == nil || !os.SameFile(a, b) || a.Size() != b.Size() || !a.ModTime().Equal(b.ModTime()) {
		return false
	}
	left, leftOK := changeTime(a)
	right, rightOK := changeTime(b)
	return leftOK == rightOK && reflect.DeepEqual(left, right)
}
func (s *Store) remember(state Object, metadata os.FileInfo, size int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := str(state["id"])
	s.forgetLocked(id)
	// shortcut: without exposed change-time, re-read rather than cache; add native metadata when profiling warrants it.
	if _, ok := changeTime(metadata); !ok {
		return
	}
	e := s.lru.PushBack(&cacheEntry{id: id, state: state, metadata: metadata, bytes: size})
	s.cache[id] = e
	s.cacheBytes += size
	for s.cacheBytes > maxCacheBytes || len(s.cache) > maxCacheEntries {
		s.forgetLocked(s.lru.Front().Value.(*cacheEntry).id)
	}
}
func (s *Store) load(id string) (Object, error) {
	path := s.path(id)
	metadata, err := os.Stat(path)
	if err != nil {
		s.forget(id)
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if _, e := os.Stat(s.archivePath(id)); e != nil {
			if errors.Is(e, os.ErrNotExist) {
				return nil, &Error{"找不到审查任务，可能已被清理", 404}
			}
			return nil, e
		}
		return nil, &Error{"评审任务已归档，可从任务列表恢复", 410}
	}
	s.mu.Lock()
	if e := s.cache[id]; e != nil {
		c := e.Value.(*cacheEntry)
		if sameSignature(c.metadata, metadata) {
			s.lru.MoveToBack(e)
			state := c.state
			s.mu.Unlock()
			return state, nil
		}
	}
	s.forgetLocked(id)
	s.mu.Unlock()
	state, err := func() (Object, error) {
		for attempt := 0; attempt < 3; attempt++ {
			if !metadata.Mode().IsRegular() {
				return nil, errors.New("不是会话文件")
			}
			raw, e := os.ReadFile(path)
			if e != nil {
				return nil, e
			}
			after, e := os.Stat(path)
			if e != nil {
				return nil, e
			}
			if !sameSignature(metadata, after) {
				metadata = after
				continue
			}
			var value any
			if e = CheckJSONUnicode(raw); e != nil {
				return nil, e
			}
			if e = json.Unmarshal(raw, &value); e != nil {
				return nil, e
			}
			parsed, e := capture(func() Object { return parseSession(value) })
			if e != nil {
				return nil, e
			}
			if parsed["id"] != id {
				return nil, errors.New("文件与会话标识不一致")
			}
			s.remember(parsed, after, len(raw))
			return parsed, nil
		}
		return nil, errors.New("会话文件正在被其他进程修改，请稍后重试")
	}()
	if err != nil {
		return nil, &Error{"会话文件损坏，原文件已保留：" + err.Error(), 500}
	}
	return state, nil
}
func writeAtomic(path string, data []byte) (os.FileInfo, error) {
	temporary := path + "." + newID() + ".tmp"
	f, e := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	defer func() { _ = f.Close(); _ = os.Remove(temporary) }()
	if _, e = f.Write(data); e != nil {
		return nil, e
	}
	if e = f.Sync(); e != nil {
		return nil, e
	}
	written, e := f.Stat()
	if e != nil {
		return nil, e
	}
	// Windows cannot rename this file while its write handle denies delete sharing.
	if e = f.Close(); e != nil {
		return nil, e
	}
	if e = os.Rename(temporary, path); e != nil {
		return nil, e
	}
	committed, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer committed.Close()
	own, e := committed.Stat()
	if e != nil {
		return nil, e
	}
	destination, e := os.Stat(path)
	if e != nil {
		return nil, e
	}
	if !os.SameFile(written, own) || written.Size() != own.Size() || written.ModTime() != own.ModTime() || !sameSignature(own, destination) {
		return nil, nil
	}
	return own, nil
}
func (s *Store) notify(e *sessionLock, state Object, err error) {
	n := e.notice
	n.state = state
	n.err = err
	e.notice = &notice{done: make(chan struct{})}
	close(n.done)
}
func (s *Store) persist(state Object, e *sessionLock) error {
	raw := []byte(stringify(state))
	if err := os.MkdirAll(s.dataDir, 0700); err != nil {
		return err
	}
	metadata, err := writeAtomic(s.path(str(state["id"])), raw)
	if err != nil {
		return err
	}
	if metadata != nil {
		s.remember(state, metadata, len(raw))
	} else {
		s.forget(str(state["id"]))
	}
	s.notify(e, state, nil)
	return nil
}
func (s *Store) output(state Object, view string) Object {
	value := state
	if view == "current" {
		s.mu.Lock()
		var cached *cacheEntry
		if e := s.cache[str(state["id"])]; e != nil && reflect.ValueOf(e.Value.(*cacheEntry).state).UnsafePointer() == reflect.ValueOf(state).UnsafePointer() {
			cached = e.Value.(*cacheEntry)
			value = cached.current
		} else {
			value = nil
		}
		s.mu.Unlock()
		if value == nil {
			value = currentSession(state)
			if cached != nil {
				s.mu.Lock()
				cached.current = value
				s.mu.Unlock()
			}
		}
	}
	return clone(value).(Object)
}
func (s *Store) Get(id, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		e := s.acquire(id)
		defer s.release(id, e)
		state, err := s.load(id)
		if err != nil {
			return nil, err
		}
		return s.output(state, view), nil
	})
}
func captureIO[T any](fn func() (T, error)) (result T, err error) {
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(*Error); ok {
				err = e
			} else {
				panic(p)
			}
		}
	}()
	return fn()
}
func (s *Store) update(id, view string, fn func(Object) (Object, bool)) (Object, error) {
	return captureIO(func() (Object, error) {
		e := s.acquire(id)
		defer s.release(id, e)
		previous, err := s.load(id)
		if err != nil {
			return nil, err
		}
		next, changed := fn(previous)
		if !changed {
			return s.output(previous, view), nil
		}
		next["version"] = integer(num(previous["version"])+1, "版本")
		next["updatedAt"] = now()
		commentRounds(obj(next["review"], ""), num(next["round"]))
		if err := s.persist(next, e); err != nil {
			return nil, err
		}
		return s.output(next, view), nil
	})
}
func (s *Store) GetSnapshot(id string, round int) (Object, error) {
	return captureIO(func() (Object, error) {
		integer(round, "轮次")
		e := s.acquire(id)
		defer s.release(id, e)
		state, err := s.load(id)
		if err != nil {
			return nil, err
		}
		snapshot := find(state["snapshots"], "round", float64(round))
		if snapshot == nil {
			fail("找不到这个流程版本", 404)
		}
		return clone(snapshot).(Object), nil
	})
}
func (s *Store) GetBaseline(id string) (Object, error) {
	return captureIO(func() (Object, error) {
		e := s.acquire(id)
		defer s.release(id, e)
		state, err := s.load(id)
		if err != nil {
			return nil, err
		}
		r := obj(state["review"], "")
		if !present(r, "baseline") {
			return nil, &Error{"未提供修改前基线", 404}
		}
		return Object{"review": clone(r["baseline"])}, nil
	})
}
func (s *Store) GetRecord(id, record string) (Object, error) {
	return captureIO(func() (Object, error) {
		requestID(record)
		e := s.acquire(id)
		defer s.release(id, e)
		state, err := s.load(id)
		if err != nil {
			return nil, err
		}
		r := find(state["history"], "id", record)
		if r == nil {
			fail("找不到这个评审记录", 404)
		}
		return clone(r).(Object), nil
	})
}
func (s *Store) readArchive(id string) (Object, error) {
	raw, err := os.ReadFile(s.archivePath(id))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, &Error{"找不到归档评审任务", 404}
		}
		return nil, err
	}
	result, err := captureIO(func() (Object, error) {
		z, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer z.Close()
		decoded, err := io.ReadAll(z)
		if err != nil {
			return nil, err
		}
		var v any
		if err = CheckJSONUnicode(decoded); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(decoded, &v); err != nil {
			return nil, err
		}
		a := request(v)
		state := parseSession(a["session"])
		if state["id"] != id {
			return nil, errors.New("文件与评审任务标识不一致")
		}
		return Object{"archivedAt": sessionDate(a["archivedAt"]), "session": state}, nil
	})
	if err != nil {
		return nil, &Error{"归档文件损坏，原文件已保留：" + err.Error(), 500}
	}
	return result, nil
}
func (s *Store) GetArchive(id string) (Object, error) {
	return captureIO(func() (Object, error) {
		e := s.acquire(id)
		defer s.release(id, e)
		a, err := s.readArchive(id)
		if err != nil {
			return nil, err
		}
		return clone(a["session"]).(Object), nil
	})
}
func directoryEntries(path string) ([]os.DirEntry, error) {
	entries, e := os.ReadDir(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	return entries, e
}

func (s *Store) List(options Object) (Object, error) {
	return captureIO(func() (Object, error) {
		if options == nil {
			options = Object{}
		}
		if present(options, "state") {
			choice(options["state"], "任务列表状态", "active", "archived", "all")
		}
		active, e := directoryEntries(s.dataDir)
		if e != nil {
			return nil, e
		}
		ids := map[string]bool{}
		for _, f := range active {
			if activePattern.MatchString(f.Name()) {
				ids[strings.TrimSuffix(f.Name(), ".json")] = true
			}
		}
		sessions := []Object{}
		warnings := []any{}
		add := func(state Object, archivedAt any) {
			if present(options, "context") {
				scope, _ := state["scope"].(Object)
				if !equal(scope["context"], options["context"]) {
					return
				}
			}
			r := Object{"id": state["id"], "title": obj(state["review"], "")["title"], "version": state["version"], "round": state["round"], "phase": state["phase"], "createdAt": state["createdAt"], "updatedAt": state["updatedAt"]}
			for k, v := range parseOptions(state) {
				r[k] = v
			}
			if archivedAt != nil {
				r["archivedAt"] = archivedAt
			}
			sessions = append(sessions, r)
		}
		unreadable := func(id string, err error) {
			var se *Error
			if errors.As(err, &se) && (se.Status == 404 || se.Status == 410) {
				return
			}
			warnings = append(warnings, fmt.Sprintf("任务 %s 无法读取，原文件已保留：%s", id, err.Error()))
		}
		if options["state"] != "archived" {
			for _, f := range active {
				if !activePattern.MatchString(f.Name()) {
					continue
				}
				id := strings.TrimSuffix(f.Name(), ".json")
				state, e := s.Get(id, "")
				if e != nil {
					unreadable(id, e)
				} else {
					add(state, nil)
				}
			}
		}
		if options["state"] == "archived" || options["state"] == "all" {
			files, e := directoryEntries(filepath.Join(s.dataDir, "archive"))
			if e != nil {
				return nil, e
			}
			for _, f := range files {
				if !archivePattern.MatchString(f.Name()) {
					continue
				}
				id := strings.TrimSuffix(f.Name(), ".json.gz")
				if ids[id] {
					continue
				}
				archive, e := captureIO(func() (Object, error) { lock := s.acquire(id); defer s.release(id, lock); return s.readArchive(id) })
				if e != nil {
					unreadable(id, e)
				} else {
					add(obj(archive["session"], ""), archive["archivedAt"])
				}
			}
		}
		sort.Slice(sessions, func(i, j int) bool {
			a, b := str(sessions[i]["updatedAt"]), str(sessions[j]["updatedAt"])
			if a != b {
				return a > b
			}
			return str(sessions[i]["id"]) < str(sessions[j]["id"])
		})
		r := Object{"sessions": arr(sessions, "")}
		if len(warnings) > 0 {
			r["warnings"] = warnings
		}
		return r, nil
	})
}
func (s *Store) WaitForChange(ctx context.Context, id string, afterVersion int, wait time.Duration, view string) (Object, error) {
	return captureIO(func() (Object, error) {
		e := s.acquire(id)
		state, err := s.load(id)
		if err != nil {
			s.release(id, e)
			return nil, err
		}
		if num(state["version"]) != float64(afterVersion) {
			out := s.output(state, view)
			s.release(id, e)
			return out, nil
		}
		n := e.notice
		e.mu.Unlock()
		defer s.unref(id, e)
		if wait < 0 {
			wait = 0
		}
		if wait > 25*time.Second {
			wait = 25 * time.Second
		}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-n.done:
			if n.err != nil {
				return nil, n.err
			}
			return s.output(n.state, view), nil
		case <-ctx.Done():
			return nil, nil
		case <-timer.C:
			return nil, nil
		case <-s.closed:
			return nil, &Error{"评审服务已停止", 503}
		}
	})
}
func (s *Store) Close() { s.once.Do(func() { close(s.closed) }) }
