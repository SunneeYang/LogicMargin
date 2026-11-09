package sourcecontext

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const sessionA = "11111111-1111-4111-8111-111111111111"
const sessionB = "22222222-2222-4222-8222-222222222222"

func source(p, content string) Source { return Source{p, sum(content), content} }

func realTempDir(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func writeGzip(t *testing.T, target string, raw []byte) {
	t.Helper()
	f, err := os.Create(target)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	if _, err := gz.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRoundTripAndIsolation(t *testing.T) {
	ctx := context.Background()
	s := NewStore(realTempDir(t))
	want := source("src/原版.go", "\ufeffpackage demo\r\n// 😀\r\n")
	if err := s.Put(ctx, sessionA, want); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(s.directory, filename(sessionA, want.Path, want.SHA256))
	before, err := os.Stat(file)
	if err != nil || runtime.GOOS != "windows" && before.Mode().Perm() != 0600 {
		t.Fatal(before, err)
	}
	if err := s.Put(ctx, sessionA, want); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(file)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("duplicate save rewrote cache")
	}
	got, err := NewStore(s.directory).Get(ctx, sessionA, want.Path, want.SHA256)
	if err != nil || got != want {
		t.Fatal(got, err)
	}
	for _, identity := range [][3]string{{sessionB, want.Path, want.SHA256}, {sessionA, "other.go", want.SHA256}, {sessionA, want.Path, sum("different")}} {
		if _, err := s.Get(ctx, identity[0], identity[1], identity[2]); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("identity crossed", identity, err)
		}
	}
	if err := s.Put(ctx, sessionB, want); err != nil {
		t.Fatal(err)
	}
	other := source("other.go", want.Content)
	if err := s.Put(ctx, sessionA, other); err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct {
		session string
		source  Source
	}{{sessionB, want}, {sessionA, other}} {
		if got, err := s.Get(ctx, pair.session, pair.source.Path, pair.source.SHA256); err != nil || got != pair.source {
			t.Fatal(got, err)
		}
	}
	boundary := source("limit.ts", strings.Repeat("a", MaxFileBytes))
	if err := s.Put(ctx, sessionA, boundary); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get(ctx, sessionA, boundary.Path, boundary.SHA256); err != nil || got != boundary {
		t.Fatal("boundary failed", err)
	}
}

func TestRejectInvalidIdentityAndContent(t *testing.T) {
	s := NewStore(filepath.Join(realTempDir(t), "not-created"))
	ctx := context.Background()
	valid := source("logic.go", "valid")
	for _, id := range []string{"", "../session", strings.ToUpper(sessionA), "11111111-1111-1111-8111-111111111111", "session-1"} {
		// sessionA contains only digits; use an actual uppercase hex letter too.
		if id == sessionA {
			id = "AAAA1111-1111-4111-8111-111111111111"
		}
		if err := s.Put(ctx, id, valid); err == nil {
			t.Fatal("accepted session", id)
		}
	}
	for _, p := range []string{"", "/a.go", "../a.go", "a/../b.go", "a//b.go", "a/./b.go", "C:/a.go", `a\b.go`, "a\x00.go", "a\n.go", " a.go", ".", strings.Repeat("a", 8001), string([]byte{0xff})} {
		bad := valid
		bad.Path = p
		if err := s.Put(ctx, sessionA, bad); err == nil {
			t.Fatal("accepted path", p)
		}
		if _, err := s.Get(ctx, sessionA, p, bad.SHA256); err == nil {
			t.Fatal("read invalid path", p)
		}
	}
	for _, bad := range []Source{{"logic.go", strings.Repeat("A", 64), "valid"}, {"logic.go", sum("wrong"), "valid"}, source("logic.go", "a\x00b"), source("logic.go", string([]byte{0xff})), source("logic.go", strings.Repeat("a", MaxFileBytes+1))} {
		if err := s.Put(ctx, sessionA, bad); err == nil {
			t.Fatal("accepted invalid content")
		}
	}
	if _, err := os.Stat(s.directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid input created directory", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.Put(canceled, sessionA, valid); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := s.Get(canceled, sessionA, valid.Path, valid.SHA256); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestCorruptionNeverReturnsSource(t *testing.T) {
	s := NewStore(realTempDir(t))
	want := source("logic.go", "original")
	target := filepath.Join(s.directory, filename(sessionA, want.Path, want.SHA256))
	for _, test := range []struct {
		name  string
		value entry
	}{
		{"content", entry{sessionA, Source{want.Path, want.SHA256, "changed"}}},
		{"session", entry{sessionB, want}},
		{"path", entry{sessionA, Source{"other.go", want.SHA256, want.Content}}},
		{"sha", entry{sessionA, source(want.Path, "other")}},
		{"oversize", entry{sessionA, source(want.Path, strings.Repeat("a", MaxFileBytes+1))}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, _ := json.Marshal(test.value)
			writeGzip(t, target, raw)
			if got, err := s.Get(context.Background(), sessionA, want.Path, want.SHA256); err == nil || got != (Source{}) {
				t.Fatal("corruption used", got.Path, err)
			}
		})
	}
	for _, raw := range [][]byte{[]byte("{bad json"), []byte("\xff"), []byte(strings.Repeat(" ", maxEntryBytes+1))} {
		writeGzip(t, target, raw)
		if _, err := s.Get(context.Background(), sessionA, want.Path, want.SHA256); err == nil {
			t.Fatal("accepted invalid decoded data")
		}
	}
	if err := s.Put(context.Background(), sessionA, want); err != nil {
		t.Fatal("cannot replace corruption", err)
	}
	raw, _ := os.ReadFile(target)
	for _, broken := range [][]byte{raw[:len(raw)-1], append(append([]byte{}, raw...), []byte("garbage")...), []byte("not gzip")} {
		if err := os.WriteFile(target, broken, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(context.Background(), sessionA, want.Path, want.SHA256); err == nil {
			t.Fatal("accepted corrupt gzip")
		}
	}
}

func TestSymlinksCannotEscape(t *testing.T) {
	ctx := context.Background()
	parent := realTempDir(t)
	outside := realTempDir(t)
	linked := filepath.Join(parent, "linked")
	if err := os.Symlink(outside, linked); err != nil {
		t.Skip(err)
	}
	want := source("logic.go", "content")
	if err := NewStore(linked).Put(ctx, sessionA, want); err == nil {
		t.Fatal("accepted linked directory")
	}
	if err := NewStore(filepath.Join(linked, "new-cache")).Put(ctx, sessionA, want); err == nil {
		t.Fatal("created cache through linked ancestor")
	}
	if _, err := os.Stat(filepath.Join(outside, "new-cache")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created outside configured directory", err)
	}
	s := NewStore(realTempDir(t))
	secret := filepath.Join(outside, "secret")
	if err := os.WriteFile(secret, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(s.directory, filename(sessionA, want.Path, want.SHA256))); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, sessionA, want.Path, want.SHA256); err == nil {
		t.Fatal("read symlink")
	}
	if err := s.Put(ctx, sessionA, want); err == nil {
		t.Fatal("wrote through symlink")
	}
	if raw, _ := os.ReadFile(secret); !bytes.Equal(raw, []byte("untouched")) {
		t.Fatal("outside file changed")
	}
}

func TestQuotaEvictionAndAbandonedTemporaryFiles(t *testing.T) {
	ctx := context.Background()
	s := NewStore(realTempDir(t))
	old, recent, next := source("old.go", "old"), source("recent.go", "recent"), source("next.go", "next")
	for _, item := range []Source{old, recent} {
		if err := s.Put(ctx, sessionA, item); err != nil {
			t.Fatal(err)
		}
	}
	oldPath := filepath.Join(s.directory, filename(sessionA, old.Path, old.SHA256))
	longAgo := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldPath, longAgo, longAgo); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(s.directory, ".source-context-"+strings.Repeat("a", 32)+".tmp")
	if err := os.WriteFile(stale, []byte("abandoned"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(stale, longAgo, longAgo); err != nil {
		t.Fatal(err)
	}
	s.maxEntries = 2
	if err := s.Put(ctx, sessionA, next); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, sessionA, old.Path, old.SHA256); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("oldest not evicted", err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale temp remains", err)
	}
	for _, item := range []Source{recent, next} {
		if _, err := s.Get(ctx, sessionA, item.Path, item.SHA256); err != nil {
			t.Fatal(err)
		}
	}
	s.budget = 1
	if err := s.Put(ctx, sessionA, source("cannot-fit.go", "other")); err == nil {
		t.Fatal("ignored byte budget")
	}
	if _, err := s.Get(ctx, sessionA, recent.Path, recent.SHA256); err != nil {
		t.Fatal("oversized save evicted valid entry", err)
	}
	files, _ := os.ReadDir(s.directory)
	var total int64
	for _, file := range files {
		info, _ := file.Info()
		total += info.Size()
	}
	s.budget = total
	if err := s.Put(ctx, sessionA, source("replacement.go", "replacement")); err != nil {
		t.Fatal(err)
	}
	files, _ = os.ReadDir(s.directory)
	total = 0
	for _, file := range files {
		info, _ := file.Info()
		total += info.Size()
		if tempPattern.MatchString(file.Name()) {
			t.Fatal("successful save left temporary data")
		}
	}
	if total > s.budget || len(files) > s.maxEntries {
		t.Fatal("quota exceeded", total, len(files))
	}
}

func TestConcurrentStoresRespectQuota(t *testing.T) {
	directory := realTempDir(t)
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			s := NewStore(directory)
			s.maxEntries = 2
			if err := s.Put(context.Background(), sessionA, source(strings.Repeat("x", i+1)+".go", "same")); err != nil {
				t.Error(err)
			}
		}(i)
	}
	workers.Wait()
	files, err := os.ReadDir(directory)
	if err != nil || len(files) != 2 {
		t.Fatal(len(files), err)
	}
}
