package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsLockProbeBusyErrors(t *testing.T) {
	for _, code := range []error{windows.ERROR_SHARING_VIOLATION, windows.ERROR_ACCESS_DENIED} {
		if !lockProbeBusy(&os.PathError{Op: "open", Path: "service.lock", Err: code}) {
			t.Fatalf("wrapped transient directory error was not retried: %v", code)
		}
	}
	for _, code := range []error{nil, windows.ERROR_FILE_NOT_FOUND, windows.ERROR_INVALID_HANDLE} {
		if lockProbeBusy(code) {
			t.Fatalf("unrelated error was classified as busy: %v", code)
		}
	}
}

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

func TestAcquireLockRetriesWindowsSharingConflict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.lock")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "2147483647."+NewID()+".owner"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	held, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if held != windows.InvalidHandle {
			_ = windows.CloseHandle(held)
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	release, err := AcquireLock(ctx, path, 3*time.Second)
	cancel()
	if release != nil {
		_ = release()
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock did not wait for sharing conflict: %v", err)
	}
	if err := windows.CloseHandle(held); err != nil {
		t.Fatal(err)
	}
	held = windows.InvalidHandle
	release, err = AcquireLock(t.Context(), path, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if other, err := AcquireLock(t.Context(), path, 0); err == nil {
		_ = other()
		t.Fatal("recovered lock was acquired twice")
	}
}

func TestAcquireLockSurvivesWindowsDestinationChurn(t *testing.T) {
	for range 10 {
		path := filepath.Join(t.TempDir(), "service.lock")
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		started, done := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(done)
			close(started)
			for ctx.Err() == nil {
				_ = os.Mkdir(path, 0700)
				_ = os.Remove(path) // Never remove a nonempty published claim.
			}
		}()
		<-started
		release, err := AcquireLock(ctx, path, 3*time.Second)
		cancel()
		<-done
		if err != nil {
			t.Fatal("destination disappearing during publication:", err)
		}
		if err := release(); err != nil {
			t.Fatal(err)
		}
	}
}
