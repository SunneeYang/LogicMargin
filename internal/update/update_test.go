package update

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"logicmargin/internal/daemon"
	"logicmargin/internal/mcpconfig"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Getenv("LM_UPDATE_TEST_HELPER") == "1" {
		switch os.Args[1] {
		case "--version":
			fmt.Println(helperVersion())
			os.Exit(0)
		case "_serve":
			os.Exit(helperServe())
		case "_fake-codex":
			os.Exit(fakeCodex(os.Args[2:]))
		case "_update-worker":
			executable, _ := os.Executable()
			client := &http.Client{Transport: rewriteTransport{os.Getenv("LM_UPDATE_TEST_RELEASE_URL"), http.DefaultTransport}}
			err := runWorker(context.Background(), os.Args[2], dependencies{client, []string{executable, "_fake-codex"}, mcpconfig.RunCommand})
			if err != nil {
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}
func helperVersion() string {
	if strings.Contains(os.Args[0], "logic-margin-agent-1.0.1-") {
		if os.Getenv("LM_UPDATE_TEST_MODE") == "binary-version" {
			return "0.9.9"
		}
		return "1.0.1"
	}
	return "1.0.0"
}
func helperServe() int {
	values := map[string]string{}
	for i := 2; i+1 < len(os.Args); i += 2 {
		values[os.Args[i]] = os.Args[i+1]
	}
	ctx := context.Background()
	unlock, err := daemon.AcquireLock(ctx, filepath.Join(values["--data-dir"], ".service-lock"), 0)
	if err != nil {
		return 1
	}
	defer unlock()
	if helperVersion() == "1.0.1" && os.Getenv("LM_UPDATE_TEST_MODE") == "restart-fail" {
		_ = os.WriteFile(filepath.Join(values["--data-dir"], "session.json"), []byte("bad new data"), 0600)
		return 1
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(values["--host"], values["--port"]))
	if err != nil {
		return 1
	}
	entry := daemon.Registry{PID: os.Getpid(), URL: "http://" + listener.Addr().String(), Host: values["--host"], InstanceID: values["--instance-id"], ShutdownToken: values["--shutdown-token"], Version: helperVersion(), StartedAt: time.Now().UTC().Format(time.RFC3339Nano), DataDir: values["--data-dir"]}
	var server http.Server
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			_ = json.NewEncoder(w).Encode(daemon.Health{Service: "logic-margin", APIVersion: 1, Version: entry.Version, InstanceID: entry.InstanceID, PID: entry.PID, Managed: true, MCP: true})
			return
		}
		if r.URL.Path == "/api/shutdown" && r.Header.Get("X-Logic-Margin-Token") == entry.ShutdownToken {
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			go func() { _ = server.Close() }()
			return
		}
		w.WriteHeader(403)
	})
	if daemon.WriteRegistry(values["--home"], entry) != nil {
		return 1
	}
	if json.NewEncoder(os.Stdout).Encode(map[string]any{"url": entry.URL, "pid": entry.PID, "instanceId": entry.InstanceID}) != nil {
		return 1
	}
	_ = server.Serve(listener)
	return 0
}
func fakeCodex(args []string) int {
	log, _ := os.OpenFile(os.Getenv("LM_UPDATE_TEST_COMMANDS"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if log != nil {
		_ = json.NewEncoder(log).Encode(args)
		_ = log.Close()
	}
	key := strings.Join(args, " ")
	if key == "plugin list --json" {
		if os.Getenv("LM_UPDATE_TEST_MODE") == "detached-cancel" {
			time.Sleep(2 * time.Second)
		}
		installedVersion := "1.0.0"
		if os.Getenv("LM_UPDATE_TEST_MODE") == "installed-newer" {
			installedVersion = "2.0.0"
		}
		fmt.Printf(`{"installed":[{"name":"logic-margin","marketplaceName":"logic-margin-local","version":%q,"enabled":true,"source":{"source":"local","path":%q}}]}`+"\n", installedVersion, os.Getenv("LM_UPDATE_TEST_OLD_INSTALL"))
		return 0
	}
	if key == "plugin marketplace list --json" {
		catalogs := []any{}
		if _, err := os.Stat(os.Getenv("LM_UPDATE_TEST_MARKETPLACE")); err == nil {
			catalogs = append(catalogs, map[string]string{"name": "logic-margin-local", "root": os.Getenv("LM_UPDATE_TEST_MARKETPLACE")})
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"marketplaces": catalogs})
		return 0
	}
	if key == "plugin marketplace remove logic-margin-local --json" {
		if os.Getenv("LM_UPDATE_TEST_MODE") == "remove-fail" {
			return 1
		}
		_ = os.RemoveAll(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"))
		if os.Getenv("LM_UPDATE_TEST_MODE") == "remove-commit-fail" {
			return 1
		}
		fmt.Println(`{"marketplaceName":"logic-margin-local"}`)
		return 0
	}
	if strings.HasPrefix(key, "plugin marketplace add ") {
		if args[3] == "SunneeYang/LogicMargin" {
			if _, err := os.Stat(os.Getenv("LM_UPDATE_TEST_MARKETPLACE")); err == nil {
				return 1 // A different configured Git ref cannot be overwritten.
			}
			if strings.HasPrefix(os.Getenv("LM_UPDATE_TEST_MODE"), "registration-") {
				return 1
			}
			_ = os.MkdirAll(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"), 0700)
		} else {
			if os.Getenv("LM_UPDATE_TEST_MODE") == "registration-restore-fail" {
				return 1
			}
			b, err := os.ReadFile(filepath.Join(args[3], "catalog.json"))
			if err != nil || string(b) != "original catalog" {
				return 1
			}
			_ = os.WriteFile(os.Getenv("LM_UPDATE_TEST_RESTORED"), b, 0600)
			_ = os.MkdirAll(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"), 0700)
			_ = os.WriteFile(filepath.Join(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"), "catalog.json"), b, 0600)
		}
		fmt.Println(`{"marketplaceName":"logic-margin-local"}`)
		return 0
	}
	if key == "plugin marketplace upgrade logic-margin-local --json" {
		if os.Getenv("LM_UPDATE_TEST_MODE") == "refresh-fail" {
			fmt.Println(`{"errors":["fixture rejection"]}`)
		} else {
			fmt.Println(`{"errors":[]}`)
		}
		return 0
	}
	if key == "plugin add logic-margin@logic-margin-local --json" {
		if os.Getenv("LM_UPDATE_TEST_MODE") == "install-fail" {
			return 1
		}
		_ = os.RemoveAll(os.Getenv("LM_UPDATE_TEST_OLD_INSTALL"))
		installed := os.Getenv("LM_UPDATE_TEST_INSTALLED")
		_ = os.MkdirAll(installed, 0700)
		_ = os.WriteFile(filepath.Join(installed, "plugin.json"), []byte(`{"name":"logic-margin","version":"1.0.1"}`), 0600)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"name": "logic-margin", "marketplaceName": "logic-margin-local", "version": "1.0.1", "installedPath": installed})
		return 0
	}
	return 1
}

type rewriteTransport struct {
	base      string
	transport http.RoundTripper
}

func (t rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	u := *req.URL
	clone.URL = &u
	baseReq, _ := http.NewRequest("GET", t.base, nil)
	clone.URL.Scheme, clone.URL.Host = baseReq.URL.Scheme, baseReq.URL.Host
	return t.transport.RoundTrip(clone)
}
func archiveFixture(t *testing.T, executable string) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	target, _ := Target(runtime.GOOS, runtime.GOARCH)
	name := "logic-margin"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	h := &zip.FileHeader{Name: "logic-margin-agent-1.0.1-" + target + "/plugins/logic-margin/skills/logic-margin/scripts/" + name, Method: zip.Deflate}
	h.SetMode(0700)
	f, err := z.CreateHeader(h)
	if err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(f, in)
	_ = in.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestReleaseVersionsPlatformsAndArchiveTrust(t *testing.T) {
	for _, tc := range []struct {
		a, b    string
		want    bool
		invalid bool
	}{{"1.10.0", "1.9.9", true, false}, {"1.0.0", "1.0.0", false, false}, {"0.9.2", "1.0.0", false, false}, {"1.0.1-beta", "1.0.0", false, true}, {"01.0.1", "1.0.0", false, true}, {"18446744073709551616.0.0", "1.0.0", false, true}} {
		got, err := newer(tc.a, tc.b)
		if got != tc.want || (err != nil) != tc.invalid {
			t.Fatalf("%+v => %v %v", tc, got, err)
		}
	}
	for _, p := range [][2]string{{"darwin", "arm64"}, {"darwin", "amd64"}, {"linux", "arm64"}, {"linux", "amd64"}, {"windows", "amd64"}} {
		if _, err := Target(p[0], p[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Target("windows", "arm64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	for _, name := range []string{"root/../escape", "/absolute", "root/evil\\path", "root/C:evil"} {
		t.Run(name, func(t *testing.T) {
			var b bytes.Buffer
			z := zip.NewWriter(&b)
			f, _ := z.Create(name)
			_, _ = f.Write([]byte("evil"))
			_ = z.Close()
			file := filepath.Join(t.TempDir(), "fixture.zip")
			_ = os.WriteFile(file, b.Bytes(), 0600)
			if extract(context.Background(), file, t.TempDir(), "root") == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestUpdateRejectsAliasedDataOverlapBeforeLaunching(t *testing.T) {
	for _, alias := range []string{"home", "updates", "data"} {
		t.Run(alias, func(t *testing.T) {
			root := t.TempDir()
			home, data := filepath.Join(root, "home"), filepath.Join(root, "data")
			for _, directory := range []string{home, data} {
				if err := os.MkdirAll(directory, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var link, target string
			switch alias {
			case "home":
				target = filepath.Join(data, "state")
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
				link, home = filepath.Join(root, "home-alias"), filepath.Join(root, "home-alias")
			case "updates":
				link, target = filepath.Join(home, "updates"), data
			case "data":
				link, target = filepath.Join(root, "data-alias"), home
				data = link
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("directory symlinks unavailable: %v", err)
			}
			original := []byte("keep current reviews")
			if err := os.WriteFile(filepath.Join(data, "session.json"), original, 0600); err != nil {
				t.Fatal(err)
			}
			manager := Manager{Home: home, DataDir: data, Version: "1.0.0"}
			if _, err := manager.Start(context.Background(), "1.0.1"); err == nil || err.Error() != "unsafe_update_directory" {
				t.Fatalf("overlap reached worker launch: %v", err)
			}
			if _, err := os.Stat(filepath.Join(home, "updates", "status.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("update status created before rejection: %v", err)
			}
			jobDir := filepath.Join(home, "updates", "fixture")
			if err := os.MkdirAll(jobDir, 0700); err != nil {
				t.Fatal(err)
			}
			jobPath := filepath.Join(jobDir, "job.json")
			if err := writeJSON(jobPath, Job{Home: home, DataDir: data, Fallback: "unused"}); err != nil {
				t.Fatal(err)
			}
			if err := runWorker(context.Background(), jobPath, dependencies{}); err == nil || err.Error() != "unsafe_update_directory" {
				t.Fatalf("persisted job bypassed overlap check: %v", err)
			}
			got, err := os.ReadFile(filepath.Join(data, "session.json"))
			if err != nil || !bytes.Equal(got, original) {
				t.Fatalf("original data changed: %q, %v", got, err)
			}
		})
	}
}
func TestUpdateRejectsCodexManagedDirectories(t *testing.T) {
	for _, managed := range []string{"plugins", ".tmp"} {
		for _, field := range []string{"home", "data"} {
			t.Run(managed+"/"+field, func(t *testing.T) {
				root := t.TempDir()
				codexHome := filepath.Join(root, "codex")
				t.Setenv("CODEX_HOME", codexHome)
				home, data := filepath.Join(root, "home"), filepath.Join(root, "data")
				if field == "home" {
					home = filepath.Join(codexHome, managed, "old-plugin", "state")
				} else {
					data = filepath.Join(codexHome, managed, "old-plugin", "sessions")
				}
				for _, directory := range []string{home, data} {
					if err := os.MkdirAll(directory, 0700); err != nil {
						t.Fatal(err)
					}
				}
				manager := Manager{Home: home, DataDir: data, Version: "1.0.0"}
				if _, err := manager.Start(context.Background(), "1.0.1"); err == nil || err.Error() != "unsafe_update_directory" {
					t.Fatalf("managed directory reached worker launch: %v", err)
				}
			})
		}
	}
}
func TestWorkerReleaseAndRestart(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	fixture := archiveFixture(t, executable)
	for _, mode := range []string{"success", "checksum-fail", "installed-newer", "binary-version", "refresh-fail", "install-fail", "restart-fail", "cancel", "cancel-install", "detached-success", "detached-cancel", "home-in-install", "data-in-install", "remove-fail", "registration-fail", "registration-restore-fail", "remove-canceled", "remove-commit-fail", "catalog-backup-overlap"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			home := filepath.Join(root, "home")
			data := filepath.Join(root, "custom-data")
			if mode == "home-in-install" {
				home = filepath.Join(root, "codex-old", "home")
			}
			if mode == "data-in-install" {
				data = filepath.Join(root, "codex-old", "data")
			}
			_ = os.MkdirAll(data, 0700)
			original := []byte(`{"id":"same-session","B":1,"R":4,"comments":["keep"],"archives":["keep"]}`)
			_ = os.WriteFile(filepath.Join(data, "session.json"), original, 0600)
			_ = os.Mkdir(filepath.Join(data, "archives"), 0700)
			_ = os.WriteFile(filepath.Join(data, "archives", "saved.json"), original, 0600)
			t.Setenv("LM_UPDATE_TEST_HELPER", "1")
			t.Setenv("LM_UPDATE_TEST_MODE", mode)
			t.Setenv("LM_UPDATE_TEST_COMMANDS", filepath.Join(root, "commands.jsonl"))
			t.Setenv("LM_UPDATE_TEST_INSTALLED", filepath.Join(root, "codex-new"))
			t.Setenv("LM_UPDATE_TEST_OLD_INSTALL", filepath.Join(root, "codex-old"))
			t.Setenv("LM_UPDATE_TEST_MARKETPLACE", filepath.Join(root, "codex-marketplace"))
			if mode == "catalog-backup-overlap" {
				t.Setenv("LM_UPDATE_TEST_MARKETPLACE", filepath.Join(home, "updates"))
			}
			t.Setenv("LM_UPDATE_TEST_RESTORED", filepath.Join(root, "catalog-restored"))
			_ = os.MkdirAll(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"), 0700)
			_ = os.WriteFile(filepath.Join(os.Getenv("LM_UPDATE_TEST_MARKETPLACE"), "catalog.json"), []byte("original catalog"), 0600)
			_ = os.MkdirAll(os.Getenv("LM_UPDATE_TEST_OLD_INSTALL"), 0700)
			oldBinary := filepath.Join(os.Getenv("LM_UPDATE_TEST_OLD_INSTALL"), filepath.Base(executable))
			if err := copyFile(executable, oldBinary); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			ready, err := daemon.Ensure(ctx, daemon.Options{Home: home, DataDir: data, Version: "1.0.0", Command: []string{oldBinary}, RequireMCP: true})
			if err != nil {
				if log, readErr := os.ReadFile(filepath.Join(home, "daemon.log")); readErr == nil {
					t.Logf("helper startup log: %s", log[max(0, len(log)-4096):])
				}
				t.Fatal(err)
			}
			t.Cleanup(func() {
				stopCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
				defer c()
				if _, err := daemon.Stop(stopCtx, home); err != nil {
					t.Error(err)
				}
			})
			var health daemon.Health
			response, err := http.Get(ready.URL + "/api/health")
			if err != nil {
				t.Fatal(err)
			}
			_ = json.NewDecoder(response.Body).Decode(&health)
			_ = response.Body.Close()
			directory := filepath.Join(home, "updates", daemon.NewID())
			_ = os.MkdirAll(directory, 0700)
			fallback := filepath.Join(directory, filepath.Base(executable))
			if err := copyFile(oldBinary, fallback); err != nil {
				t.Fatal(err)
			}
			job := Job{home, data, health.InstanceID, "1.0.1", "1.0.0", fallback}
			jobPath := filepath.Join(directory, "job.json")
			if err := writeJSON(jobPath, job); err != nil {
				t.Fatal(err)
			}
			target, _ := Target(runtime.GOOS, runtime.GOARCH)
			asset := "logic-margin-agent-1.0.1-" + target + ".zip"
			hash := sha256.Sum256(fixture)
			digest := hex.EncodeToString(hash[:])
			if mode == "checksum-fail" {
				digest = strings.Repeat("0", 64)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, ".sha256"):
					fmt.Fprintf(w, "%s  %s\n", digest, asset)
				case strings.HasSuffix(r.URL.Path, ".zip"):
					_, _ = w.Write(fixture)
				default:
					fmt.Fprint(w, `{"tag_name":"v1.0.1","draft":false,"prerelease":false}`)
				}
			}))
			defer server.Close()
			client := &http.Client{Transport: rewriteTransport{server.URL, http.DefaultTransport}}
			workerCtx, cancelWorker := context.WithCancel(ctx)
			defer cancelWorker()
			runner := func(c context.Context, dir string, env, command []string) ([]byte, error) {
				b, e := mcpconfig.RunCommand(c, dir, env, command)
				key := strings.Join(command, " ")
				if mode == "remove-canceled" && strings.Contains(key, "marketplace remove") {
					cancelWorker()
					return b, context.Canceled
				}
				if strings.Contains(key, "marketplace add") {
					for _, lockPath := range []string{filepath.Join(home, "start.lock"), filepath.Join(data, ".service-lock")} {
						unlock, lockErr := daemon.AcquireLock(context.Background(), lockPath, 0)
						if lockErr == nil {
							_ = unlock()
							t.Errorf("update lost exclusive lock: %s", lockPath)
						}
					}
				}
				if (mode == "cancel" && strings.Contains(key, "plugin list")) || (mode == "cancel-install" && strings.Contains(key, "marketplace add")) {
					cancelWorker()
				}
				return b, e
			}
			if strings.HasPrefix(mode, "detached-") {
				t.Setenv("LM_UPDATE_TEST_RELEASE_URL", server.URL)
				manager := &Manager{Home: home, DataDir: data, InstanceID: health.InstanceID, Version: "1.0.0"}
				started, startErr := manager.Start(ctx, "1.0.1")
				if startErr != nil {
					t.Fatal(startErr)
				}
				directory = filepath.Join(home, "updates", started.ID)
				if mode == "detached-cancel" {
					if cancelErr := manager.Cancel(); cancelErr != nil {
						t.Fatal(cancelErr)
					}
				}
				deadline := time.Now().Add(15 * time.Second)
				for time.Now().Before(deadline) {
					state, e := manager.Status()
					if e != nil {
						t.Fatal(e)
					}
					if !active(state.Phase) {
						expected := "completed"
						if mode == "detached-cancel" {
							expected = "canceled"
							err = context.Canceled
						}
						if state.Phase != expected {
							t.Fatalf("detached worker: %+v", state)
						}
						break
					}
					time.Sleep(20 * time.Millisecond)
				}
			} else {
				err = runWorker(workerCtx, jobPath, dependencies{client, []string{executable, "_fake-codex"}, runner})
			}
			if (mode == "success" || mode == "detached-success") && err != nil {
				t.Fatal(err)
			}
			if mode != "success" && mode != "detached-success" && err == nil {
				t.Fatal("expected failure")
			}
			status, statErr := (&Manager{Home: home}).Status()
			if statErr != nil {
				t.Fatal(statErr)
			}
			wantPhase := "failed"
			if mode == "success" || mode == "detached-success" {
				wantPhase = "completed"
			}
			if mode == "cancel" || mode == "cancel-install" || mode == "detached-cancel" || mode == "remove-canceled" {
				wantPhase = "canceled"
			}
			if status.Phase != wantPhase {
				t.Fatalf("status %+v error %v", status, err)
			}
			wantVersion := "1.0.0"
			if mode == "success" || mode == "detached-success" {
				wantVersion = "1.0.1"
			}
			actual, err := daemon.Status(ctx, home, wantVersion)
			if err != nil || actual["running"] != true || actual["version"] != wantVersion {
				t.Fatalf("service: %+v %v", actual, err)
			}
			if actual["url"] != ready.URL {
				t.Fatal("port changed")
			}
			for _, file := range []string{"session.json", filepath.Join("archives", "saved.json")} {
				b, err := os.ReadFile(filepath.Join(data, file))
				if err != nil || !bytes.Equal(b, original) {
					t.Fatalf("data changed %s: %s %v", file, b, err)
				}
			}
			commands, _ := os.ReadFile(os.Getenv("LM_UPDATE_TEST_COMMANDS"))
			if mode == "home-in-install" || mode == "data-in-install" || mode == "catalog-backup-overlap" {
				if status.Error != "unsafe_update_directory" || actual["pid"] != health.PID || bytes.Contains(commands, []byte(`"marketplace","remove"`)) || bytes.Contains(commands, []byte(`"marketplace","add"`)) {
					t.Fatalf("unsafe install reached stop or plugin mutation: %+v, %s", status, commands)
				}
				if _, err := os.Stat(filepath.Join(directory, "backup")); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("backup created before rejection: %v", err)
				}
			}
			if mode == "success" || mode == "detached-success" {
				removeAt := bytes.Index(commands, []byte(`"remove","logic-margin-local"`))
				addAt := bytes.Index(commands, []byte(`"--ref","v1.0.1"`))
				if removeAt < 0 || addAt < removeAt || !bytes.Contains(commands, []byte(`"upgrade","logic-margin-local"`)) || !bytes.Contains(commands, []byte(`"add","logic-margin@logic-margin-local"`)) {
					t.Fatalf("missing pinned separate steps: %s", commands)
				}
				if _, err := os.Stat(oldBinary); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("old installation was not removed by fixture")
				}
			}
			if mode == "registration-fail" || mode == "remove-canceled" || mode == "remove-commit-fail" {
				restored, err := os.ReadFile(os.Getenv("LM_UPDATE_TEST_RESTORED"))
				if err != nil || string(restored) != "original catalog" || !strings.Contains(status.Error, "old_service_restored") {
					t.Fatalf("catalog was lost after registration failure: %+v, %v", status, err)
				}
			}
			if mode == "registration-restore-fail" && !strings.Contains(status.Error, "codex_marketplace_restore_failed") {
				t.Fatalf("catalog recovery failure was hidden: %+v", status)
			}
			if mode == "restart-fail" {
				failed, err := os.ReadFile(filepath.Join(directory, "failed-data", "session.json"))
				if err != nil || string(failed) != "bad new data" {
					t.Fatalf("failed data lost: %s %v", failed, err)
				}
			}
		})
	}
}
func TestBackupRejectsLinksAndCancellation(t *testing.T) {
	source := t.TempDir()
	dest := filepath.Join(t.TempDir(), "backup")
	_ = os.WriteFile(filepath.Join(source, "keep"), []byte("keep"), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(copyData(ctx, source, dest), context.Canceled) {
		t.Fatal("cancellation ignored")
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink("keep", filepath.Join(source, "link")); err != nil {
			t.Fatal(err)
		}
		if copyData(context.Background(), source, dest) == nil {
			t.Fatal("backup followed link")
		}
	}
}

func TestManagerBusyCancelAndInterruptedStatus(t *testing.T) {
	home := t.TempDir()
	data := filepath.Join(home, "sessions")
	_ = os.MkdirAll(data, 0700)
	manager := &Manager{Home: home, DataDir: data, Version: "1.0.0"}
	for _, v := range []string{"1.0.0", "0.9.9", "https://evil.test", "1.0.2-beta"} {
		if _, err := manager.Start(context.Background(), v); err == nil {
			t.Fatalf("accepted %s", v)
		}
	}
	id := daemon.NewID()
	directory := filepath.Join(home, "updates", id)
	_ = os.MkdirAll(directory, 0700)
	status := Status{ID: id, Phase: "downloading", PID: os.Getpid()}
	if err := writeJSON(filepath.Join(home, "updates", "status.json"), status); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), "1.0.1"); err == nil || err.Error() != "update_busy" {
		t.Fatalf("duplicate update accepted: %v", err)
	}
	if err := manager.Cancel(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, "cancel")); err != nil {
		t.Fatal(err)
	}
	status.PID = 1 << 30
	_ = writeJSON(filepath.Join(home, "updates", "status.json"), status)
	actual, err := manager.Status()
	if err != nil || actual.Phase != "failed" || actual.Error != "update_worker_interrupted" {
		t.Fatalf("stale status: %+v %v", actual, err)
	}
	manager.DataDir = home
	if _, err := manager.Start(context.Background(), "1.0.1"); err == nil || err.Error() != "unsafe_update_directory" {
		t.Fatalf("recursive backup accepted: %v", err)
	}
}

func TestReleaseRejectsDraftPrereleaseAndVersionMismatch(t *testing.T) {
	for _, body := range []string{`{"tag_name":"v1.0.1","draft":true}`, `{"tag_name":"v1.0.1","prerelease":true}`, `{"tag_name":"v1.0.1-beta"}`, `{"tag_name":"v1.0.2"}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		_, err := check(context.Background(), &http.Client{Transport: rewriteTransport{server.URL, http.DefaultTransport}}, "1.0.0", "1.0.1")
		server.Close()
		if err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}
