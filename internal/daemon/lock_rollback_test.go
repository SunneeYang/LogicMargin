package daemon

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"testing"
)

func TestRollbackLockOwnership(t *testing.T) {
	for _, state := range []string{"owned", "different-owner", "replaced-directory", "unknown-file", "missing"} {
		t.Run(state, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "service.lock")
			name := fmt.Sprintf("%d.%s.owner", os.Getpid(), NewID())
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(path, name), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			identity, err := directoryIdentity(path)
			if err != nil {
				t.Fatal(err)
			}
			switch state {
			case "different-owner":
				other := fmt.Sprintf("%d.%s.owner", os.Getpid(), NewID())
				if err := os.Rename(filepath.Join(path, name), filepath.Join(path, other)); err != nil {
					t.Fatal(err)
				}
			case "replaced-directory":
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path, name), []byte("replacement"), 0600); err != nil {
					t.Fatal(err)
				}
			case "unknown-file":
				if err := os.WriteFile(filepath.Join(path, "user-data"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(filepath.Join(path, name)); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			snapshot := func() map[string]string {
				entries, err := os.ReadDir(path)
				if err != nil {
					t.Fatal(err)
				}
				files := map[string]string{}
				for _, entry := range entries {
					data, err := os.ReadFile(filepath.Join(path, entry.Name()))
					if err != nil {
						t.Fatal(err)
					}
					files[entry.Name()] = string(data)
				}
				return files
			}
			var before map[string]string
			if state != "missing" {
				before = snapshot()
			}
			err = rollbackLock(path, name, identity)
			if state == "unknown-file" {
				if err == nil {
					t.Fatal("unconfirmed cleanup was reported as successful")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if state == "owned" || state == "missing" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("failed claim remains: %v", err)
				}
			} else if !maps.Equal(before, snapshot()) {
				t.Fatal("rollback changed another owner, replacement, or unknown file")
			}
		})
	}
}
