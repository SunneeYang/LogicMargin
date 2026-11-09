package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type Registry struct {
	PID           int    `json:"pid"`
	URL           string `json:"url"`
	Host          string `json:"host"`
	InstanceID    string `json:"instanceId"`
	ShutdownToken string `json:"shutdownToken"`
	Version       string `json:"version"`
	StartedAt     string `json:"startedAt"`
	DataDir       string `json:"dataDir,omitempty"`
}

type Options struct {
	Home       string
	URL        string
	Host       string
	Port       *int
	DataDir    string
	Version    string
	Command    []string
	RequireMCP bool
}

type Result struct {
	URL     string `json:"url"`
	Managed bool   `json:"managed"`
}

type Health struct {
	Service    string `json:"service"`
	APIVersion int    `json:"apiVersion"`
	Version    string `json:"version"`
	InstanceID string `json:"instanceId"`
	PID        int    `json:"pid"`
	Managed    bool   `json:"managed"`
	MCP        bool   `json:"mcp"`
}

func HomePath(home string) (string, error) {
	if home == "" {
		home = os.Getenv("LOGIC_MARGIN_HOME")
	}
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = filepath.Join(userHome, ".logic-margin")
	}
	return filepath.Abs(home)
}

func validURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}

func registry(home string) (*Registry, error) {
	path := filepath.Join(home, "daemon.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entry Registry
	if json.Unmarshal(raw, &entry) != nil || entry.PID <= 0 || !validURL(entry.URL) || entry.Host == "" || entry.InstanceID == "" || entry.ShutdownToken == "" || entry.Version == "" {
		return nil, fmt.Errorf("后台服务记录损坏，原文件已保留：%s", path)
	}
	if _, err := time.Parse(time.RFC3339Nano, entry.StartedAt); err != nil {
		return nil, fmt.Errorf("后台服务记录损坏，原文件已保留：%s", path)
	}
	return &entry, nil
}

func health(ctx context.Context, base string) *Health {
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/health", nil)
	if err != nil {
		return nil
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	var value Health
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	var fields map[string]json.RawMessage
	if err != nil || len(raw) > 8192 || json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &value) != nil || (string(fields["managed"]) != "true" && string(fields["managed"]) != "false") || response.StatusCode != 200 || value.Service != "logic-margin" || value.APIVersion != 1 || value.Version == "" || value.InstanceID == "" || value.PID <= 0 {
		return nil
	}
	return &value
}

func sameInstance(entry *Registry, value *Health) bool {
	return entry != nil && value != nil && value.Managed && entry.PID == value.PID && entry.InstanceID == value.InstanceID
}

func compatible(value *Health, version string) error {
	if value.Version != version {
		return fmt.Errorf("已运行 LogicMargin %s，当前程序为 %s；请先停止旧服务后重试", value.Version, version)
	}
	return nil
}

func Status(ctx context.Context, home, version string) (map[string]any, error) {
	home, err := HomePath(home)
	if err != nil {
		return nil, err
	}
	entry, err := registry(home)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return map[string]any{"running": false, "managed": false}, nil
	}
	value := health(ctx, entry.URL)
	result := map[string]any{"running": sameInstance(entry, value), "managed": true, "url": entry.URL, "pid": entry.PID, "version": entry.Version, "processRunning": ProcessAlive(entry.PID)}
	if !sameInstance(entry, value) {
		if value != nil {
			result["reason"] = "健康接口与登记实例身份不匹配，未接管该进程"
		} else {
			result["reason"] = "登记的后台实例不可达，请核对进程状态与 daemon.log"
		}
		return result, nil
	}
	result["host"], result["compatible"], result["processRunning"] = entry.Host, value.Version == version, true
	result["version"] = value.Version
	if value.MCP {
		result["mcpUrl"] = entry.URL + "/mcp"
	}
	return result, nil
}

func Ensure(ctx context.Context, opts Options) (Result, error) {
	if opts.URL != "" {
		return Result{opts.URL, false}, nil
	}
	home, err := HomePath(opts.Home)
	if err != nil {
		return Result{}, err
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		return Result{}, err
	}
	release, err := AcquireLock(ctx, filepath.Join(home, "start.lock"), 10*time.Second)
	if err != nil {
		return Result{}, err
	}
	defer release()
	entry, err := registry(home)
	if err != nil {
		return Result{}, err
	}
	if entry != nil {
		value := health(ctx, entry.URL)
		if sameInstance(entry, value) {
			if err := compatible(value, opts.Version); err != nil {
				return Result{}, err
			}
			if opts.RequireMCP && !value.MCP {
				return Result{}, errors.New("已登记服务尚未提供 MCP，请先 server stop 后用当前程序重启")
			}
			u, _ := url.Parse(entry.URL)
			if opts.Host != "" && opts.Host != entry.Host || opts.Port != nil && *opts.Port != 0 && strconv.Itoa(*opts.Port) != u.Port() {
				return Result{}, errors.New("已运行服务的监听地址不同，请先 server stop 再按新地址启动")
			}
			return Result{entry.URL, true}, nil
		}
		if ProcessAlive(entry.PID) {
			return Result{}, errors.New("已登记服务进程仍在运行但健康检查失败，未启动第二个写入进程；请先检查 server status 与 daemon.log")
		}
	}
	if !opts.RequireMCP && opts.Home == "" && os.Getenv("LOGIC_MARGIN_HOME") == "" && opts.Host == "" && opts.Port == nil {
		if value := health(ctx, "http://127.0.0.1:5173"); value != nil {
			if err := compatible(value, opts.Version); err != nil {
				return Result{}, err
			}
			return Result{"http://127.0.0.1:5173", false}, nil
		}
	}
	if len(opts.Command) == 0 {
		return Result{}, errors.New("缺少后台服务启动命令；请使用完整安装包，或显式指定 --url")
	}
	if opts.DataDir == "" {
		opts.DataDir = os.Getenv("LOGIC_MARGIN_DATA_DIR")
	}
	if entry != nil {
		if opts.Host == "" {
			opts.Host = entry.Host
		}
		if opts.Port == nil {
			u, _ := url.Parse(entry.URL)
			port, _ := strconv.Atoi(u.Port())
			opts.Port = &port
		}
		if opts.DataDir == "" {
			opts.DataDir = entry.DataDir
		}
	}
	if opts.Host == "" {
		opts.Host = "127.0.0.1"
	}
	return spawn(ctx, home, opts)
}

func spawn(ctx context.Context, home string, opts Options) (result Result, err error) {
	instance, token := NewID(), NewID()
	port := 0
	if opts.Port != nil {
		port = *opts.Port
	}
	args := append(append([]string{}, opts.Command[1:]...), "_serve", "--home", home, "--host", opts.Host, "--port", strconv.Itoa(port), "--instance-id", instance, "--shutdown-token", token)
	if opts.DataDir != "" {
		args = append(args, "--data-dir", opts.DataDir)
	}
	log, err := os.OpenFile(filepath.Join(home, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return result, err
	}
	defer log.Close()
	cmd := exec.Command(opts.Command[0], args...)
	cmd.Stderr = log
	detach(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return result, err
	}
	defer stdout.Close()
	if err := cmd.Start(); err != nil {
		return result, err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		if err != nil {
			_ = cmd.Process.Kill()
			select {
			case <-exited:
			case <-time.After(time.Second):
			}
		}
	}()
	type readyResult struct {
		raw string
		err error
	}
	read := make(chan readyResult, 1)
	go func() {
		raw, err := bufio.NewReader(io.LimitReader(stdout, 8193)).ReadString('\n')
		read <- readyResult{raw, err}
	}()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case <-startup.Done():
		return result, errors.New("LogicMargin 后台服务未在 10 秒内启动，请查看 daemon.log")
	case <-exited:
		return result, fmt.Errorf("LogicMargin 后台服务提前退出，请查看 %s", filepath.Join(home, "daemon.log"))
	case message := <-read:
		if len(message.raw) > 8192 {
			return result, errors.New("后台服务启动响应过大")
		}
		var ready struct {
			URL        string `json:"url"`
			InstanceID string `json:"instanceId"`
			PID        int    `json:"pid"`
		}
		if message.err != nil || json.Unmarshal([]byte(message.raw), &ready) != nil || !validURL(ready.URL) || ready.InstanceID != instance || ready.PID != cmd.Process.Pid {
			return result, errors.New("后台服务启动响应无效；后台服务可能提前退出，请查看 daemon.log")
		}
		value := health(startup, ready.URL)
		if value == nil || value.InstanceID != instance || value.PID != cmd.Process.Pid {
			return result, errors.New("后台服务启动后健康检查失败")
		}
		if err := compatible(value, opts.Version); err != nil {
			return result, err
		}
		return Result{ready.URL, true}, nil
	}
}

func Stop(ctx context.Context, home string) (bool, error) {
	home, err := HomePath(home)
	if err != nil {
		return false, err
	}
	release, err := AcquireLock(ctx, filepath.Join(home, "start.lock"), 10*time.Second)
	if err != nil {
		return false, err
	}
	defer release()
	return stop(ctx, home)
}

func stop(ctx context.Context, home string) (bool, error) {
	entry, err := registry(home)
	if err != nil || entry == nil {
		return false, err
	}
	if !sameInstance(entry, health(ctx, entry.URL)) {
		if ProcessAlive(entry.PID) {
			return false, errors.New("后台实例身份或健康状态不匹配，未关闭该进程")
		}
		return false, nil
	}
	stopCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(stopCtx, http.MethodPost, entry.URL+"/api/shutdown", nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("x-logic-margin-token", entry.ShutdownToken)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8192))
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("后台服务拒绝停止：HTTP %d", response.StatusCode)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !sameInstance(entry, health(ctx, entry.URL)) && !ProcessAlive(entry.PID) {
			return true, nil
		}
		if err := pause(ctx, 50*time.Millisecond); err != nil {
			return false, err
		}
	}
	return false, errors.New("后台服务未在 5 秒内停止，会话数据已保留")
}

func WriteRegistry(home string, entry Registry) error {
	if err := os.MkdirAll(home, 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	path := filepath.Join(home, "daemon.json")
	tmp := path + "." + entry.InstanceID + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp, path)
}
