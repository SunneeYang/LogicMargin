package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsUpdateFileIOErrors(t *testing.T) {
	for _, code := range []error{windows.ERROR_ACCESS_DENIED, windows.ERROR_SHARING_VIOLATION, windows.ERROR_FILE_NOT_FOUND, windows.ERROR_INVALID_HANDLE} {
		t.Run(code.Error(), func(t *testing.T) {
			original := &os.PathError{Op: "open", Path: "status.json", Err: code}
			attempts := 0
			err := retryUpdateFileIO(func() error {
				attempts++
				if attempts == 1 {
					return original
				}
				return nil
			})
			if code == windows.ERROR_ACCESS_DENIED || code == windows.ERROR_SHARING_VIOLATION {
				if err != nil || attempts != 2 {
					t.Fatalf("transient error was not retried: attempts=%d, err=%v", attempts, err)
				}
			} else if err != original || attempts != 1 {
				t.Fatalf("unrelated error was retried or replaced: attempts=%d, err=%v", attempts, err)
			}
		})
	}
}

func TestWindowsStatusMissingAndInvalid(t *testing.T) {
	home := t.TempDir()
	manager := &Manager{Home: home}
	if status, err := manager.Status(); err != nil || status.Phase != "idle" {
		t.Fatalf("missing status changed behavior: %+v, %v", status, err)
	}
	path := filepath.Join(home, "updates", "status.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Status(); err == nil || err.Error() != "invalid_update_status" {
		t.Fatalf("invalid JSON error was swallowed: %v", err)
	}
}

func TestWindowsStatusFileSharing(t *testing.T) {
	for _, operation := range []string{"read", "replace"} {
		for _, release := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/release-%t", operation, release), func(t *testing.T) {
				home := t.TempDir()
				path := filepath.Join(home, "updates", "status.json")
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				old, next := Status{ID: "old", Phase: "completed"}, Status{ID: "new", Phase: "completed"}
				if err := writeJSON(path, old); err != nil {
					t.Fatal(err)
				}
				name, err := windows.UTF16PtrFromString(path)
				if err != nil {
					t.Fatal(err)
				}
				held, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
				if err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				defer func() {
					if held != windows.InvalidHandle {
						_ = windows.CloseHandle(held)
					}
					<-done
				}()
				go func() {
					defer close(done)
					if operation == "replace" {
						done <- writeJSON(path, next)
						return
					}
					_, err := (&Manager{Home: home}).Status()
					done <- err
				}()
				select {
				case err := <-done:
					t.Fatalf("sharing conflict returned before retrying: %v", err)
				case <-time.After(40 * time.Millisecond):
				}
				raw := make([]byte, 1024)
				var n uint32
				if err := windows.ReadFile(held, raw, &n, nil); err != nil {
					t.Fatal(err)
				}
				expected, _ := json.Marshal(old)
				if !bytes.Equal(raw[:n], expected) {
					t.Fatalf("locked destination changed before replacement: %q", raw[:n])
				}
				closeHeld := func() {
					if err := windows.CloseHandle(held); err != nil {
						t.Fatal(err)
					}
					held = windows.InvalidHandle
				}
				if release {
					closeHeld()
				}
				select {
				case err := <-done:
					if release {
						if err != nil {
							t.Fatalf("operation did not recover after handle release: %v", err)
						}
					} else {
						if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
							t.Fatalf("permanent conflict lost its original Windows error: %v", err)
						}
						closeHeld()
					}
				case <-time.After(2 * time.Second):
					t.Fatal("sharing retries did not stop within their bounded budget")
				}
				if release && operation == "replace" {
					expected, _ = json.Marshal(next)
				}
				actual, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(actual, expected) {
					t.Fatalf("expected complete old or new JSON, got %q, %v", actual, err)
				}
				if files, err := filepath.Glob(path + ".*.tmp"); err != nil || len(files) != 0 {
					t.Fatalf("temporary replacement files remain: %v, %v", files, err)
				}
			})
		}
	}
}
