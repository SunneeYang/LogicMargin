package daemon

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStaleLockWaitsForWindowsDirectoryHandles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lock")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "2147483647."+NewID()+".owner"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	held, err := os.OpenRoot(path)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	if stale, err := staleLock(path); stale || err != nil {
		t.Fatalf("held directory must be temporarily busy: stale=%v, err=%v", stale, err)
	}
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	release, err := AcquireLock(t.Context(), path, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
}
