package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"logicmargin/internal/agent"
	"logicmargin/internal/daemon"
	"logicmargin/internal/mcpconfig"
	"logicmargin/internal/service"
	"logicmargin/internal/ui"
	"logicmargin/internal/update"
)

var version = "0.9.11"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "LogicMargin: "+err.Error())
		os.Exit(1)
	}
}

func flags(args, allowed []string) (map[string]string, error) {
	values := map[string]string{}
	for at := 0; at < len(args); at += 2 {
		name := args[at]
		valid := false
		for _, key := range allowed {
			if name == key {
				valid = true
				break
			}
		}
		_, duplicate := values[name]
		if !valid || at+1 >= len(args) || duplicate {
			return nil, fmt.Errorf("无效或重复的服务参数：%s", name)
		}
		values[name] = args[at+1]
		if name == "--port" && args[at+1] == "" {
			return nil, errors.New("端口须为 0–65535 的整数")
		}
	}
	return values, nil
}

func port(raw string) (*int, error) {
	if raw == "" {
		return nil, nil
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return nil, errors.New("端口须为 0–65535 的整数")
		}
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n > 65535 {
		return nil, errors.New("端口须为 0–65535 的整数")
	}
	return &n, nil
}

func output(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func run(ctx context.Context, args []string, out, errOut io.Writer) error {
	if len(args) == 2 && args[0] == "_update-worker" {
		return update.RunWorker(ctx, args[1])
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		_, err := fmt.Fprintln(out, version)
		return err
	}
	if len(args) > 0 && args[0] == "_serve" {
		return serve(ctx, args[1:], out)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "server" {
		if len(args) < 2 {
			return errors.New("用法：server start/setup [--host HOST] [--port PORT] | server status | server stop")
		}
		action := args[1]
		allowed := []string{}
		if action == "start" || action == "setup" {
			allowed = []string{"--host", "--port"}
		} else if action != "status" && action != "stop" {
			return errors.New("用法：server start/setup [--host HOST] [--port PORT] | server status | server stop")
		}
		values, err := flags(args[2:], allowed)
		if err != nil {
			return err
		}
		switch action {
		case "status":
			value, err := daemon.Status(ctx, "", version)
			if err != nil {
				return err
			}
			return output(out, value)
		case "stop":
			stopped, err := daemon.Stop(ctx, "")
			if err != nil {
				return err
			}
			return output(out, map[string]any{"stopped": stopped})
		default:
			p, err := port(values["--port"])
			if err != nil {
				return err
			}
			value, err := daemon.Ensure(ctx, daemon.Options{Host: values["--host"], Port: p, Version: version, Command: []string{executable}, RequireMCP: true})
			if err != nil {
				return err
			}
			result := map[string]any{"url": value.URL, "managed": value.Managed, "mcpUrl": value.URL + "/mcp"}
			if action == "setup" {
				configured, err := mcpconfig.Configure(ctx, value.URL+"/mcp", version, mcpconfig.Options{})
				if err != nil {
					return err
				}
				result["mcp"] = configured
			}
			return output(out, result)
		}
	}
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		if err := agent.Run(ctx, []string{"--help"}, out, errOut, agent.Options{ConsumeSubmission: true}); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "\n  server start [--host HOST] [--port PORT]\n  server setup [--host HOST] [--port PORT]  (register HTTP MCP in this Codex home)\n  server status\n  server stop\n\nOne daemon serves HTTP MCP, review API and embedded UI. CLI commands exit when complete.")
		return err
	}
	opts := agent.Options{ConsumeSubmission: true, ResolveURL: func(ctx context.Context) (string, error) {
		value, err := daemon.Ensure(ctx, daemon.Options{Version: version, Command: []string{executable}})
		return value.URL, err
	}}
	return agent.Run(ctx, args, out, errOut, opts)
}

func serve(ctx context.Context, args []string, out io.Writer) (err error) {
	values, err := flags(args, []string{"--home", "--host", "--port", "--instance-id", "--shutdown-token", "--data-dir"})
	if err != nil {
		return err
	}
	if values["--instance-id"] == "" || values["--shutdown-token"] == "" {
		return errors.New("后台服务缺少实例凭据")
	}
	p, err := port(values["--port"])
	if err != nil {
		return err
	}
	home, err := daemon.HomePath(values["--home"])
	if err != nil {
		return err
	}
	dataDir := values["--data-dir"]
	if dataDir == "" {
		dataDir = os.Getenv("LOGIC_MARGIN_DATA_DIR")
	}
	if dataDir == "" {
		dataDir = filepath.Join(home, "sessions")
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	release, err := daemon.AcquireLock(ctx, filepath.Join(dataDir, ".service-lock"), 0)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := release(); err == nil {
			err = releaseErr
		}
	}()
	host := values["--host"]
	if host == "" {
		host = "127.0.0.1"
	}
	listenPort := 0
	if p != nil {
		listenPort = *p
	}
	server, err := service.Start(service.Options{Assets: ui.Assets(), DataDir: dataDir, Host: host, Port: listenPort, InstanceID: values["--instance-id"], Version: version, ShutdownToken: values["--shutdown-token"], Home: home})
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := server.Close(); err == nil {
			err = closeErr
		}
	}()
	entry := daemon.Registry{PID: os.Getpid(), URL: server.URL, Host: host, InstanceID: values["--instance-id"], ShutdownToken: values["--shutdown-token"], Version: version, StartedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), DataDir: dataDir}
	if err := daemon.WriteRegistry(home, entry); err != nil {
		return err
	}
	if err := json.NewEncoder(out).Encode(map[string]any{"url": server.URL, "instanceId": entry.InstanceID, "pid": entry.PID}); err != nil {
		return err
	}
	select {
	case <-server.Done():
		return nil
	case <-ctx.Done():
		return server.Close()
	}
}
