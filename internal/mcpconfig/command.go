package mcpconfig

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"time"
)

type boundedOutput struct {
	data  []byte
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > b.limit {
		return 0, errors.New("command_output_limit")
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

// RunCommand reuses the platform process-tree cleanup used by Codex configuration.
func RunCommand(ctx context.Context, directory string, env, command []string) ([]byte, error) {
	if len(command) == 0 {
		return nil, errors.New("missing_command")
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir, cmd.Env = directory, env
	output := &boundedOutput{limit: 4 * 1024 * 1024}
	cmd.Stdout = output
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return nil, err
	}
	defer null.Close()
	cmd.Stderr = null
	cmd.WaitDelay = 500 * time.Millisecond
	kill, err := startCommand(cmd)
	if err != nil {
		return nil, err
	}
	defer kill()
	err = cmd.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return output.data, err
}
