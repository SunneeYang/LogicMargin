package mcpconfig

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Options struct {
	Command []string
	Timeout time.Duration
}
type Configured struct {
	ServerName     string  `json:"serverName"`
	URL            string  `json:"url"`
	ToolTimeoutSec float64 `json:"toolTimeoutSec"`
	ReloadRequired bool    `json:"reloadRequired"`
}

func endpoint(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("MCP 地址必须是本机 HTTP /mcp 地址")
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme != "http" || (host != "127.0.0.1" && host != "localhost" && host != "::1") || u.User != nil || u.EscapedPath() != "/mcp" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New("MCP 地址必须是本机 HTTP /mcp 地址")
	}
	p := u.Port()
	u.Host = host
	if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	}
	if p != "" && p != "80" {
		u.Host = net.JoinHostPort(host, p)
	}
	return u.String(), nil
}

func object(value any) (map[string]any, error) {
	result, ok := value.(map[string]any)
	if !ok || result == nil {
		return nil, errors.New("Codex 配置接口返回了无效响应")
	}
	return result, nil
}

func Configure(parent context.Context, rawURL, version string, opts Options) (Configured, error) {
	base, err := endpoint(rawURL)
	if err != nil {
		return Configured{}, err
	}
	command := opts.Command
	if command == nil {
		command = []string{"codex"}
	}
	if opts.Timeout == 0 {
		opts.Timeout = 10 * time.Second
	}
	if len(command) == 0 || opts.Timeout < 0 {
		return Configured{}, errors.New("Codex 配置命令或超时无效")
	}
	ctx, cancel := context.WithTimeout(parent, opts.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], append(append([]string{}, command[1:]...), "app-server")...)
	cmd.Dir, _ = os.UserHomeDir()
	cmd.Env = os.Environ()
	if home := os.Getenv("CODEX_HOME"); home != "" {
		absolute, err := filepath.Abs(home)
		if err != nil {
			return Configured{}, err
		}
		cmd.Env = append(cmd.Env, "CODEX_HOME="+absolute)
	}
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return Configured{}, err
	}
	defer null.Close()
	cmd.Stderr = null
	cmd.WaitDelay = 500 * time.Millisecond
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Configured{}, errors.New("Codex 配置连接已中断，未确认 MCP 配置")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return Configured{}, err
	}
	kill, err := startCommand(cmd)
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return Configured{}, errors.New("无法启动 Codex 配置进程；请确认 codex 命令可用")
	}
	closed := make(chan error, 1)
	go func() { closed <- cmd.Wait() }()
	defer func() {
		_ = stdin.Close()
		select {
		case <-closed:
		case <-time.After(500 * time.Millisecond):
			_ = kill()
			_ = stdout.Close()
			select {
			case <-closed:
			case <-time.After(500 * time.Millisecond):
			}
		}
		_ = kill()
		_ = stdout.Close()
	}()
	type response struct {
		value map[string]any
		err   error
	}
	messages := make(chan response)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 4*1024*1024+1)
		bytes := 0
		for scanner.Scan() {
			line := scanner.Bytes()
			bytes += len(line) + 1
			var value map[string]any
			var err error
			if bytes > 4*1024*1024 {
				err = errors.New("Codex 配置接口响应超过 4 MB")
			} else if len(line) == 0 {
				continue
			} else if json.Unmarshal(line, &value) != nil || value == nil {
				err = errors.New("Codex 配置接口返回了无效 JSON")
			}
			select {
			case messages <- response{value, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
		select {
		case messages <- response{err: errors.New("Codex 配置进程提前退出，未确认 MCP 配置；请检查 Codex 安装与配置")}:
		case <-ctx.Done():
		}
	}()
	nextID := 0
	write := func(value any) error {
		if err := json.NewEncoder(stdin).Encode(value); err != nil {
			return errors.New("Codex 配置连接已中断，未确认 MCP 配置")
		}
		return nil
	}
	request := func(method string, params any) (any, error) {
		nextID++
		if err := write(map[string]any{"id": nextID, "method": method, "params": params}); err != nil {
			return nil, err
		}
		for {
			select {
			case <-ctx.Done():
				return nil, errors.New("Codex 配置接口超时，配置结果未确认；请核对后重试")
			case message := <-messages:
				if message.err != nil {
					return nil, message.err
				}
				if message.value["id"] != float64(nextID) {
					continue
				}
				// API errors can contain configuration contents; never echo them.
				if _, ok := message.value["error"]; ok {
					return nil, fmt.Errorf("Codex 配置接口 %s 不支持或拒绝操作，未确认 MCP 配置", method)
				}
				value, ok := message.value["result"]
				if !ok {
					return nil, errors.New("Codex 配置接口响应缺少结果")
				}
				return value, nil
			}
		}
	}
	if _, err := request("initialize", map[string]any{"clientInfo": map[string]any{"name": "logic_margin_setup", "version": version}}); err != nil {
		return Configured{}, err
	}
	if err := write(map[string]any{"method": "initialized"}); err != nil {
		return Configured{}, err
	}
	value, err := request("config/read", map[string]any{"includeLayers": true})
	if err != nil {
		return Configured{}, err
	}
	read, err := object(value)
	if err != nil {
		return Configured{}, err
	}
	config, err := object(read["config"])
	if err != nil {
		return Configured{}, err
	}
	servers := map[string]any{}
	if config["mcp_servers"] != nil {
		servers, err = object(config["mcp_servers"])
		if err != nil {
			return Configured{}, err
		}
	}
	existing := map[string]any{}
	if raw, ok := servers["logic_margin"]; ok {
		existing, err = object(raw)
		if err != nil {
			return Configured{}, err
		}
		previous, ok := existing["url"].(string)
		checked, checkErr := endpoint(previous)
		_, hasCommand := existing["command"]
		if !ok || checkErr != nil || checked != base || hasCommand {
			return Configured{}, errors.New("同名 logic_margin MCP 已指向其他服务，原配置已保留；请先核对配置")
		}
		if existing["enabled"] == false {
			return Configured{}, errors.New("logic_margin MCP 已被禁用，原配置已保留；请先明确启用该服务")
		}
	}
	timeout := 86400.0
	if old, ok := existing["tool_timeout_sec"].(float64); ok && old > timeout {
		timeout = old
	}
	if existing["url"] != base || existing["tool_timeout_sec"] != timeout {
		params := map[string]any{"edits": []any{
			map[string]any{"keyPath": "mcp_servers.logic_margin.url", "value": base, "mergeStrategy": "replace"},
			map[string]any{"keyPath": "mcp_servers.logic_margin.tool_timeout_sec", "value": timeout, "mergeStrategy": "replace"},
		}}
		if layers, ok := read["layers"].([]any); ok {
			for _, layer := range layers {
				item, err := object(layer)
				if err != nil {
					return Configured{}, err
				}
				name, err := object(item["name"])
				if err != nil {
					return Configured{}, err
				}
				if name["type"] == "user" && name["profile"] == nil {
					if v, ok := item["version"].(string); ok {
						params["expectedVersion"] = v
					}
					break
				}
			}
		}
		if _, err := request("config/batchWrite", params); err != nil {
			return Configured{}, err
		}
		value, err := request("config/read", map[string]any{"includeLayers": false})
		if err != nil {
			return Configured{}, err
		}
		checked, err := object(value)
		if err != nil {
			return Configured{}, err
		}
		checked, err = object(checked["config"])
		if err != nil {
			return Configured{}, err
		}
		checked, err = object(checked["mcp_servers"])
		if err != nil {
			return Configured{}, err
		}
		checked, err = object(checked["logic_margin"])
		if err != nil {
			return Configured{}, err
		}
		if checked["url"] != base || checked["tool_timeout_sec"] != timeout {
			return Configured{}, errors.New("Codex 未确认预期的 MCP 地址和超时，请核对配置后重试")
		}
	}
	return Configured{"logic_margin", base, timeout, true}, nil
}
