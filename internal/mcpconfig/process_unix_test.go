//go:build !windows

package mcpconfig

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestTimedOutWrapperDoesNotKeepDescendantPipesOrProcesses(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child-pid")
	program := fmt.Sprintf("sleep 60 & child=$!; printf '%%s' \"$child\" > '%s'; wait", strings.ReplaceAll(pidFile, "'", "'\\''"))
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := RunCommand(ctx, t.TempDir(), os.Environ(), []string{"/bin/sh", "-c", program})
	if err == nil {
		t.Fatal("wrapper unexpectedly completed")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("timeout cleanup blocked", time.Since(started))
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(raw))
	if err != nil || pid <= 0 {
		t.Fatal(string(raw), err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for syscall.Kill(pid, 0) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if syscall.Kill(pid, 0) == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("wrapper descendant %d remained alive", pid)
	}
}
