package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLockOwnershipAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lock")
	ctx := context.Background()
	release, err := AcquireLock(ctx, path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireLock(ctx, path, 0); err == nil {
		t.Fatal("live lock was acquired twice")
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	old := "2147483647." + NewID() + ".owner"
	if err := os.WriteFile(filepath.Join(path, old), nil, 0600); err != nil {
		t.Fatal(err)
	}
	release, err = AcquireLock(ctx, path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(path, old)); !os.IsNotExist(err) {
		t.Fatal("stale lock not replaced")
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(path, "unrecognized-data")
	if err := os.WriteFile(unknown, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-5 * time.Second)
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireLock(ctx, path, 0); err == nil {
		t.Fatal("unknown lock contents discarded")
	}
	if raw, err := os.ReadFile(unknown); err != nil || string(raw) != "preserve" {
		t.Fatal("unknown contents changed", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := AcquireLock(cancelled, path, time.Second); err != context.Canceled {
		t.Fatal(err)
	}
}

func TestEnsureExplicitAndCorruptRegistry(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	value, err := Ensure(context.Background(), Options{Home: home, URL: "http://unreachable.invalid:5173"})
	if err != nil || value.Managed || value.URL != "http://unreachable.invalid:5173" {
		t.Fatal(value, err)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("explicit remote URL created local managed state")
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "daemon.json")
	if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(context.Background(), Options{Home: home, Command: []string{"missing"}}); err == nil || !strings.Contains(err.Error(), "记录损坏") {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "{broken" {
		t.Fatal("corrupt registry was replaced")
	}
}

func TestIdentityAndVersionChecks(t *testing.T) {
	home := t.TempDir()
	value := Health{Service: "logic-margin", APIVersion: 1, Version: "old", InstanceID: "instance", PID: os.Getpid(), Managed: true, MCP: true}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			t.Error("unexpected request", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	defer server.Close()
	entry := Registry{PID: os.Getpid(), URL: server.URL, Host: "127.0.0.1", InstanceID: "instance", ShutdownToken: "secret", Version: "old", StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := WriteRegistry(home, entry); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(context.Background(), Options{Home: home, Version: "new"}); err == nil || !strings.Contains(err.Error(), "停止旧服务") {
		t.Fatal(err)
	}
	status, err := Status(context.Background(), home, "new")
	if err != nil || status["running"] != true || status["compatible"] != false || status["mcpUrl"] != server.URL+"/mcp" {
		t.Fatal(status, err)
	}
	entry.InstanceID = "unrelated"
	if err := WriteRegistry(home, entry); err != nil {
		t.Fatal(err)
	}
	if _, err := Stop(context.Background(), home); err == nil || !strings.Contains(err.Error(), "身份或健康状态不匹配") {
		t.Fatal(err)
	}
	if _, err := Ensure(context.Background(), Options{Home: home, Version: "old"}); err == nil || !strings.Contains(err.Error(), "进程仍在运行") {
		t.Fatal(err)
	}
}

func TestPublishedLockHasOwnerAndDoesNotReplaceEmptyDirectory(t *testing.T) {
	base := t.TempDir()
	from, to := filepath.Join(base, "prepared"), filepath.Join(base, "lock")
	if err := os.Mkdir(from, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(from, "owner"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(to, 0700); err != nil {
		t.Fatal(err)
	}
	if err := publishLock(from, to); err == nil {
		t.Fatal("replaced an existing empty claim")
	}
	if err := os.Remove(to); err != nil {
		t.Fatal(err)
	}
	if err := publishLock(from, to); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(to); err != nil || len(entries) != 1 || entries[0].Name() != "owner" {
		t.Fatal(entries, err)
	}
}

func TestStaleLockRecoveryHasOneConcurrentWinner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lock")
	for iteration := 0; iteration < 40; iteration++ {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "2147483647."+NewID()+".owner"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		const contenders = 12
		start := make(chan struct{})
		releases := make(chan func() error, contenders)
		var wg sync.WaitGroup
		for i := 0; i < contenders; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if release, err := AcquireLock(context.Background(), path, 0); err == nil {
					releases <- release
				}
			}()
		}
		close(start)
		wg.Wait()
		close(releases)
		count := 0
		for release := range releases {
			count++
			if err := release(); err != nil {
				t.Fatal(err)
			}
		}
		if count != 1 {
			t.Fatalf("iteration %d: %d writers acquired one lock", iteration, count)
		}
	}
}

func TestReleaseIsBoundToTheAcquiredDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lock")
	old, err := AcquireLock(context.Background(), path, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer old()
	before, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	err = os.Rename(path, path+".previous")
	if runtime.GOOS == "windows" {
		if err == nil {
			t.Fatal("open lock directory did not prevent replacement")
		}
		after, readErr := os.ReadDir(path)
		if readErr != nil || len(after) != 1 || after[0].Name() != before[0].Name() {
			t.Fatal("refused replacement changed the lock owner", after, readErr)
		}
		if err := old(); err != nil {
			t.Fatal(err)
		}
		release, err := AcquireLock(context.Background(), path, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	current, err := AcquireLock(context.Background(), path, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer current()
	before, err = os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := old(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadDir(path)
	if err != nil || len(after) != 1 || after[0].Name() != before[0].Name() {
		t.Fatal("old release changed a replacement directory", after, err)
	}
}
