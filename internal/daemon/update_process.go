package daemon

import (
	"os"
	"os/exec"
	"path/filepath"
)

func LaunchUpdateWorker(binary, job, directory string) (int, error) {
	log, err := os.OpenFile(filepath.Join(directory, "worker.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	defer log.Close()
	cmd := exec.Command(binary, "_update-worker", job)
	cmd.Dir = directory
	cmd.Env = os.Environ()
	if codexHome := os.Getenv("CODEX_HOME"); codexHome != "" {
		absolute, err := filepath.Abs(codexHome)
		if err != nil {
			return 0, err
		}
		cmd.Env = append(cmd.Env, "CODEX_HOME="+absolute)
	}
	cmd.Stdout, cmd.Stderr = log, log
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	go func() { _ = cmd.Wait() }()
	return cmd.Process.Pid, nil
}
