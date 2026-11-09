package mcpconfig

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestConfigHelper(t *testing.T) {
	at := -1
	for i, arg := range os.Args {
		if arg == "--" {
			at = i
			break
		}
	}
	if at < 0 || len(os.Args) < at+4 {
		return
	}
	path, mode := os.Args[at+1], os.Args[at+2]
	raw, err := os.ReadFile(path)
	if err != nil {
		os.Exit(2)
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil {
		os.Exit(3)
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var message map[string]any
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			os.Exit(4)
		}
		if mode == "exit" {
			os.Exit(5)
		}
		if mode == "timeout" {
			time.Sleep(2 * time.Second)
			continue
		}
		if message["id"] == nil {
			continue
		}
		var result any = map[string]any{}
		switch message["method"] {
		case "config/read":
			result = map[string]any{"config": config, "layers": []any{map[string]any{"name": map[string]any{"type": "user", "profile": nil}, "version": "fixture-version"}}}
		case "config/batchWrite":
			if mode == "error" {
				fmt.Fprintf(os.Stdout, "{\"id\":%v,\"error\":{\"message\":\"fixture-secret\"}}\n", message["id"])
				continue
			}
			params := message["params"].(map[string]any)
			if params["expectedVersion"] != "fixture-version" {
				os.Exit(6)
			}
			for _, raw := range params["edits"].([]any) {
				edit := raw.(map[string]any)
				keys := strings.Split(edit["keyPath"].(string), ".")
				current := config
				for _, key := range keys[:len(keys)-1] {
					if current[key] == nil {
						current[key] = map[string]any{}
					}
					current = current[key].(map[string]any)
				}
				current[keys[len(keys)-1]] = edit["value"]
			}
			raw, _ := json.Marshal(config)
			if os.WriteFile(path, raw, 0600) != nil {
				os.Exit(7)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"id": message["id"], "result": result})
	}
	os.Exit(0)
}

func fixture(t *testing.T, config map[string]any, mode string) (string, Options) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	raw, _ := json.Marshal(config)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return path, Options{Command: []string{executable, "-test.run=^TestConfigHelper$", "--", path, mode}, Timeout: 3 * time.Second}
}

func TestConfigurePreservesAndIsIdempotent(t *testing.T) {
	path, opts := fixture(t, map[string]any{"model": "preserve", "mcp_servers": map[string]any{"other": map[string]any{"command": "keep"}}}, "normal")
	const base = "http://127.0.0.1:50123/mcp"
	result, err := Configure(context.Background(), base, "0.8.7", opts)
	if err != nil || result.URL != base || !result.ReloadRequired || result.ToolTimeoutSec != 86400 {
		t.Fatal(result, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	_ = json.Unmarshal(raw, &config)
	expected := map[string]any{"model": "preserve", "mcp_servers": map[string]any{"other": map[string]any{"command": "keep"}, "logic_margin": map[string]any{"url": base, "tool_timeout_sec": float64(86400)}}}
	if !reflect.DeepEqual(config, expected) {
		t.Fatal(config)
	}
	if _, err := Configure(context.Background(), base, "0.8.7", opts); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(path)
	if string(raw) != string(again) {
		t.Fatal("idempotent setup changed config")
	}
}

func TestConfigureRejectsConflictsAndInvalidEndpoints(t *testing.T) {
	const base = "http://127.0.0.1:50123/mcp"
	for _, existing := range []map[string]any{{"url": "http://127.0.0.1:50124/mcp"}, {"command": "stdio"}, {"url": base, "enabled": false}} {
		path, opts := fixture(t, map[string]any{"mcp_servers": map[string]any{"logic_margin": existing}}, "normal")
		before, _ := os.ReadFile(path)
		if _, err := Configure(context.Background(), base, "0.8.7", opts); err == nil {
			t.Fatal("conflict accepted")
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatal("conflicting config changed")
		}
	}
	for _, base := range []string{"https://127.0.0.1/mcp", "http://remote.example/mcp", "http://user@127.0.0.1/mcp", "http://127.0.0.1/api", "http://127.0.0.1/mcp?token=x"} {
		if _, err := Configure(context.Background(), base, "0.8.7", Options{Command: []string{"missing"}}); err == nil || !strings.Contains(err.Error(), "本机 HTTP") {
			t.Fatal(err)
		}
	}
}

func TestEndpointCanonicalization(t *testing.T) {
	for input, want := range map[string]string{"http://LOCALHOST:80/mcp": "http://localhost/mcp", "http://[::1]:80/mcp": "http://[::1]/mcp", "http://127.0.0.1:50123/mcp": "http://127.0.0.1:50123/mcp"} {
		got, err := endpoint(input)
		if err != nil || got != want {
			t.Fatal(input, got, err)
		}
	}
	if _, err := endpoint("http://127.0.0.1/m%63p"); err == nil {
		t.Fatal("encoded endpoint accepted")
	}
}

func TestConfigureFailureDoesNotExposeChildOutput(t *testing.T) {
	for _, mode := range []string{"exit", "timeout", "error"} {
		_, opts := fixture(t, map[string]any{}, mode)
		if mode == "timeout" {
			opts.Timeout = 100 * time.Millisecond
		}
		_, err := Configure(context.Background(), "http://127.0.0.1:50123/mcp", "0.8.7", opts)
		if err == nil || strings.Contains(err.Error(), "fixture-secret") {
			t.Fatal(err)
		}
	}
}
