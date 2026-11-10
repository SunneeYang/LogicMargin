package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

var ownerName = regexp.MustCompile(`^(\d+)\.([a-f0-9-]{36})\.owner$`)

func ownerFS(directory fs.FS) (name string, pid int, err error) {
	entries, err := fs.ReadDir(directory, ".")
	if errors.Is(err, os.ErrNotExist) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	if len(entries) != 1 {
		return "", 0, nil
	}
	parts := ownerName.FindStringSubmatch(entries[0].Name())
	if parts == nil {
		return "", 0, nil
	}
	pid, err = strconv.Atoi(parts[1])
	if err != nil || pid <= 0 {
		return "", 0, nil
	}
	return entries[0].Name(), pid, nil
}

func directoryIdentity(path string) (os.FileInfo, error) {
	directory, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	// Windows path stats load IDs lazily; rename or another open handle can invalidate that lookup.
	info, err := directory.Stat(".")
	closeErr := directory.Close()
	if err != nil {
		return nil, err
	}
	return info, closeErr
}

func staleLock(path string) (bool, error) {
	directory, err := os.OpenRoot(path)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	defer directory.Close()
	info, err := directory.Stat(".")
	if err != nil {
		return false, err
	}
	name, pid, err := ownerFS(directory.FS())
	if err != nil {
		return false, err
	}
	if pid > 0 && ProcessAlive(pid) {
		return false, nil
	}
	if name == "" && time.Since(info.ModTime()) < 2*time.Second {
		return false, nil
	}
	if name != "" {
		if err := directory.Remove(name); errors.Is(err, os.ErrNotExist) {
			return false, nil
		} else if err != nil {
			return false, err
		}
	}
	_ = directory.Close()
	current, err := directoryIdentity(path)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if !os.SameFile(info, current) {
		return false, nil
	}
	if err := os.Remove(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return true, nil
		}
		// Unknown files are preserved even in an old lock directory.
		if entries, readErr := os.ReadDir(path); readErr == nil {
			if len(entries) > 0 || lockRemovalBusy(err) {
				return false, nil
			}
		}
		return false, err
	}
	return true, nil
}

func AcquireLock(ctx context.Context, path string, wait time.Duration) (release func() error, resultErr error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	name := fmt.Sprintf("%d.%s.owner", os.Getpid(), NewID())
	prepared := path + "." + NewID() + ".tmp"
	if err := os.Mkdir(prepared, 0700); err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(filepath.Join(prepared, name)); _ = os.Remove(prepared) }()
	file, err := os.OpenFile(filepath.Join(prepared, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	identity, err := directoryIdentity(prepared)
	if err != nil {
		return nil, err
	}
	published := false
	defer func() {
		if published && resultErr != nil {
			if err := rollbackLock(path, name, identity); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("回收未完成服务锁：%w", err))
			}
		}
	}()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Publish owner and directory together so a stale reaper cannot remove an empty new claim.
		if err := publishLock(prepared, path); err != nil {
			if !errors.Is(err, os.ErrExist) {
				if _, statErr := os.Stat(path); statErr != nil {
					// The previous holder may remove the destination between rename and stat.
					if !lockPublishBusy(err) || !time.Now().Before(deadline) {
						return nil, err
					}
					if err := pause(ctx, 50*time.Millisecond); err != nil {
						return nil, err
					}
					continue
				}
			}
			stale, err := staleLock(path)
			if err != nil && !lockProbeBusy(err) {
				return nil, fmt.Errorf("探测服务锁：%w", err)
			}
			if stale {
				continue
			}
			if !time.Now().Before(deadline) {
				if err != nil {
					return nil, fmt.Errorf("探测服务锁：%w", err)
				}
				return nil, fmt.Errorf("服务锁仍被其他进程占用：%s", path)
			}
			if err := pause(ctx, 50*time.Millisecond); err != nil {
				return nil, err
			}
			continue
		}
		published = true
		directory, err := os.OpenRoot(path)
		for err != nil && lockProbeBusy(err) && time.Now().Before(deadline) {
			if err := pause(ctx, 50*time.Millisecond); err != nil {
				return nil, err
			}
			directory, err = os.OpenRoot(path)
		}
		if err != nil {
			return nil, fmt.Errorf("确认服务锁：%w", err)
		}
		current, err := directory.Stat(".")
		if err != nil {
			_ = directory.Close()
			return nil, fmt.Errorf("确认服务锁身份：%w", err)
		}
		if !os.SameFile(identity, current) {
			_ = directory.Close()
			return nil, fmt.Errorf("服务锁目录已变化：%s", path)
		}
		var once sync.Once
		var releaseErr error
		return func() error {
			once.Do(func() { releaseErr = releaseLock(directory, path, name, identity) })
			return releaseErr
		}, nil
	}
}

func releaseLock(directory *os.Root, path, name string, identity os.FileInfo) error {
	defer directory.Close()
	current, _, err := ownerFS(directory.FS())
	if err != nil {
		return err
	}
	if current != name {
		return nil
	}
	if err := directory.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = directory.Close()
	info, err := directoryIdentity(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !os.SameFile(identity, info) {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		if entries, readErr := os.ReadDir(path); readErr != nil || len(entries) == 0 {
			return err
		}
	}
	return nil
}

func rollbackLock(path, name string, identity os.FileInfo) error {
	deadline := time.Now().Add(250 * time.Millisecond)
	for {
		err := func() error {
			directory, err := os.OpenRoot(path)
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			defer directory.Close()
			current, err := directory.Stat(".")
			if err != nil {
				return err
			}
			if !os.SameFile(identity, current) {
				return nil
			}
			owner, _, err := ownerFS(directory.FS())
			if err != nil {
				return err
			}
			if owner != name {
				if _, err := directory.Lstat(name); !errors.Is(err, os.ErrNotExist) {
					if err != nil {
						return err
					}
					return fmt.Errorf("服务锁包含未知文件，保留原目录：%s", path)
				}
				return nil
			}
			return releaseLock(directory, path, name, identity)
		}()
		// A canceled acquisition still needs a bounded rollback of its published claim.
		if err == nil || !lockRemovalBusy(err) || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func pause(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
