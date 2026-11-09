//go:build !windows

package mcpconfig

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
)

func startCommand(cmd *exec.Cmd) (func() error, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var once sync.Once
	var killErr error
	kill := func() error {
		once.Do(func() {
			killErr = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			if errors.Is(killErr, syscall.ESRCH) {
				killErr = nil
			}
		})
		return killErr
	}
	cmd.Cancel = kill
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return kill, nil
}
