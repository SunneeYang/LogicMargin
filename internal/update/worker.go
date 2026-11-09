package update

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"logicmargin/internal/daemon"
	"logicmargin/internal/mcpconfig"
)

type Status struct {
	ID               string `json:"id,omitempty"`
	Phase            string `json:"phase"`
	Version          string `json:"version,omitempty"`
	PreviousVersion  string `json:"previousVersion,omitempty"`
	PID              int    `json:"pid,omitempty"`
	Error            string `json:"error,omitempty"`
	Backup           string `json:"backup,omitempty"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	ReloadRequired   bool   `json:"reloadRequired,omitempty"`
}
type Job struct{ Home, DataDir, InstanceID, Version, PreviousVersion, Fallback string }
type Manager struct {
	Home, DataDir, InstanceID, Version string
	mu                                 sync.Mutex
}

func active(phase string) bool {
	return phase != "idle" && phase != "completed" && phase != "failed" && phase != "canceled"
}
func writeJSON(file string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp := file + "." + daemon.NewID() + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp, file)
}
func (m *Manager) Status() (Status, error) {
	if m.Home == "" {
		return Status{Phase: "idle"}, nil
	}
	raw, err := os.ReadFile(filepath.Join(m.Home, "updates", "status.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Status{Phase: "idle"}, nil
	}
	if err != nil {
		return Status{}, err
	}
	var status Status
	if json.Unmarshal(raw, &status) != nil {
		return Status{}, errors.New("invalid_update_status")
	}
	if active(status.Phase) && status.PID > 0 && !daemon.ProcessAlive(status.PID) {
		status.Phase = "failed"
		status.Error = "update_worker_interrupted"
	}
	return status, nil
}
func contained(root, child string) bool {
	r, e := filepath.Rel(root, child)
	return e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(os.PathSeparator))
}
func validateUpdateDirectories(home, data string) error {
	if !filepath.IsAbs(home) || !filepath.IsAbs(data) {
		return errors.New("unsafe_update_directory")
	}
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	realData, err := filepath.EvalSymlinks(data)
	if err != nil {
		return err
	}
	updates := filepath.Join(realHome, "updates")
	if resolved, err := filepath.EvalSymlinks(updates); err == nil {
		updates = resolved
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Resolve aliases before checking overlap so a backup cannot include itself.
	if contained(realData, updates) || contained(updates, realData) {
		return errors.New("unsafe_update_directory")
	}
	return nil
}
func validateInstallDirectories(home, data, source string) error {
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		codexHome = filepath.Join(userHome, ".codex")
	}
	codexHome, err := filepath.Abs(codexHome)
	if err != nil {
		return err
	}
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	realData, err := filepath.EvalSymlinks(data)
	if err != nil {
		return err
	}
	for _, directory := range []string{filepath.Join(codexHome, "plugins"), filepath.Join(codexHome, ".tmp"), source} {
		if directory == "" {
			continue
		}
		resolved, err := filepath.EvalSymlinks(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if contained(resolved, realHome) || contained(resolved, realData) {
			return errors.New("unsafe_update_directory")
		}
	}
	return nil
}
func (m *Manager) Start(ctx context.Context, version string) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := validateUpdateDirectories(m.Home, m.DataDir); err != nil {
		return Status{}, err
	}
	if err := validateInstallDirectories(m.Home, m.DataDir, ""); err != nil {
		return Status{}, err
	}
	isNew, err := newer(version, m.Version)
	if err != nil || !isNew {
		return Status{}, errors.New("invalid_update_version")
	}
	unlock, err := daemon.AcquireLock(ctx, filepath.Join(m.Home, "update-request.lock"), 0)
	if err != nil {
		return Status{}, errors.New("update_busy")
	}
	defer unlock()
	prior, err := m.Status()
	if err != nil {
		return Status{}, err
	}
	if active(prior.Phase) {
		return prior, errors.New("update_busy")
	}
	id := daemon.NewID()
	directory := filepath.Join(m.Home, "updates", id)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return Status{}, err
	}
	executable, err := os.Executable()
	if err != nil {
		return Status{}, err
	}
	fallback := filepath.Join(directory, filepath.Base(executable))
	if err := copyFile(executable, fallback); err != nil {
		return Status{}, err
	}
	job := Job{m.Home, m.DataDir, m.InstanceID, version, m.Version, fallback}
	jobPath := filepath.Join(directory, "job.json")
	if err := writeJSON(jobPath, job); err != nil {
		return Status{}, err
	}
	status := Status{ID: id, Phase: "queued", Version: version, PreviousVersion: m.Version}
	// The worker waits for this lock until its PID/status have been durably recorded.
	handoff, err := daemon.AcquireLock(ctx, filepath.Join(m.Home, "update.lock"), 0)
	if err != nil {
		return Status{}, errors.New("update_busy")
	}
	defer handoff()
	pid, err := daemon.LaunchUpdateWorker(fallback, jobPath, directory)
	if err != nil {
		return Status{}, err
	}
	status.PID = pid
	if err := writeJSON(filepath.Join(m.Home, "updates", "status.json"), status); err != nil {
		if process, findErr := os.FindProcess(pid); findErr == nil {
			_ = process.Kill()
		}
		return Status{}, err
	}
	return status, nil
}
func (m *Manager) Cancel() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	status, err := m.Status()
	if err != nil {
		return err
	}
	if !active(status.Phase) {
		return errors.New("no_active_update")
	}
	return os.WriteFile(filepath.Join(m.Home, "updates", status.ID, "cancel"), []byte("cancel\n"), 0600)
}
func copyFile(source, dest string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("unsupported_backup_file")
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm()&0700)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func copyData(ctx context.Context, source, dest string) error {
	return filepath.WalkDir(source, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, file)
		if err != nil {
			return err
		}
		if rel == ".service-lock" && entry.IsDir() {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("symlink_in_data_directory")
		}
		target := filepath.Join(dest, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		return copyFile(file, target)
	})
}
func restoreData(ctx context.Context, backup, data, failed string) error {
	if err := os.Mkdir(failed, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(data)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".service-lock" {
			continue
		}
		if err := os.Rename(filepath.Join(data, entry.Name()), filepath.Join(failed, entry.Name())); err != nil {
			return err
		}
	}
	return copyData(ctx, backup, data)
}

type dependencies struct {
	client *http.Client
	codex  []string
	run    func(context.Context, string, []string, []string) ([]byte, error)
}

func RunWorker(ctx context.Context, jobPath string) error {
	return runWorker(ctx, jobPath, dependencies{releaseClient(), []string{"codex"}, mcpconfig.RunCommand})
}
func runWorker(parent context.Context, jobPath string, deps dependencies) (result error) {
	raw, err := os.ReadFile(jobPath)
	if err != nil {
		return err
	}
	var job Job
	if json.Unmarshal(raw, &job) != nil {
		return errors.New("invalid_update_job")
	}
	directory := filepath.Dir(jobPath)
	id := filepath.Base(directory)
	if !filepath.IsAbs(job.Home) || !filepath.IsAbs(job.DataDir) || directory != filepath.Join(job.Home, "updates", id) || job.Fallback == "" {
		return errors.New("invalid_update_job")
	}
	if err := validateUpdateDirectories(job.Home, job.DataDir); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	unlock, err := daemon.AcquireLock(ctx, filepath.Join(job.Home, "update.lock"), 10*time.Second)
	if err != nil {
		return err
	}
	defer unlock()
	status := Status{ID: id, PID: os.Getpid(), Phase: "checking", Version: job.Version, PreviousVersion: job.PreviousVersion}
	stateFile := filepath.Join(job.Home, "updates", "status.json")
	phase := func(value string) error { status.Phase = value; return writeJSON(stateFile, status) }
	defer func() {
		if result != nil {
			status.Phase = "failed"
			status.Error = result.Error()
			if errors.Is(result, context.Canceled) {
				status.Phase = "canceled"
			}
		}
		_ = writeJSON(stateFile, status)
	}()
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := os.Stat(filepath.Join(directory, "cancel")); err == nil {
					cancel()
					return
				}
			}
		}
	}()
	run := func(command []string) ([]byte, error) {
		call, c := context.WithTimeout(ctx, 2*time.Minute)
		defer c()
		return deps.run(call, job.Home, os.Environ(), command)
	}
	codex := func(args ...string) (map[string]json.RawMessage, error) {
		b, err := run(append(append([]string{}, deps.codex...), args...))
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, errors.New("codex_command_failed")
		}
		var obj map[string]json.RawMessage
		if json.Unmarshal(b, &obj) != nil || obj == nil {
			return nil, errors.New("codex_invalid_response")
		}
		return obj, nil
	}
	if err := phase("checking"); err != nil {
		return err
	}
	fallbackVersion, err := run([]string{job.Fallback, "--version"})
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil || strings.TrimSpace(string(fallbackVersion)) != job.PreviousVersion {
		return errors.New("fallback_version_mismatch")
	}
	// An existing enabled Codex installation is required; never silently install into another host.
	list, err := codex("plugin", "list", "--json")
	if err != nil {
		return err
	}
	var installed []struct {
		Name            string
		MarketplaceName string
		Version         string
		Enabled         bool
		Source          struct{ Source, Path string }
	}
	if json.Unmarshal(list["installed"], &installed) != nil {
		return errors.New("codex_invalid_response")
	}
	found := false
	for _, plugin := range installed {
		if plugin.Name == "logic-margin" && plugin.MarketplaceName == "logic-margin-local" && plugin.Enabled {
			ahead, err := newer(plugin.Version, job.Version)
			if err != nil || ahead {
				return errors.New("installed_plugin_version_conflict")
			}
			source := ""
			if plugin.Source.Source == "local" {
				source = plugin.Source.Path
				if !filepath.IsAbs(source) {
					return errors.New("codex_installation_unverified")
				}
			}
			if err := validateInstallDirectories(job.Home, job.DataDir, source); err != nil {
				return err
			}
			found = true
		}
	}
	if !found {
		return errors.New("codex_installation_required")
	}
	release, err := check(ctx, deps.client, job.PreviousVersion, job.Version)
	if err != nil {
		return err
	}
	if !release.Newer {
		return errors.New("invalid_update_version")
	}
	if err := phase("downloading"); err != nil {
		return err
	}
	binary, err := download(ctx, deps.client, job.Version, directory)
	if err != nil {
		return err
	}
	output, err := run([]string{binary, "--version"})
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil || strings.TrimSpace(string(output)) != job.Version {
		return errors.New("binary_version_mismatch")
	}
	if err := phase("stopping"); err != nil {
		return err
	}
	err = daemon.Replace(ctx, job.Home, job.InstanceID, job.DataDir, job.Version, binary, job.Fallback, func(ctx context.Context) error {
		if err := phase("backing_up"); err != nil {
			return err
		}
		backup := filepath.Join(directory, "backup")
		if err := copyData(ctx, job.DataDir, backup); err != nil {
			return err
		}
		status.Backup = backup
		if err := phase("marketplace"); err != nil {
			return err
		}
		added, err := codex("plugin", "marketplace", "add", "SunneeYang/LogicMargin", "--ref", "v"+job.Version, "--sparse", ".agents/plugins", "--sparse", "plugins/logic-margin", "--json")
		if err != nil {
			return err
		}
		var name string
		if json.Unmarshal(added["marketplaceName"], &name) != nil || name != "logic-margin-local" {
			return errors.New("codex_marketplace_mismatch")
		}
		refreshed, err := codex("plugin", "marketplace", "upgrade", "logic-margin-local", "--json")
		if err != nil {
			return err
		}
		var failures []json.RawMessage
		if len(refreshed["errors"]) == 0 || refreshed["errors"][0] != '[' || json.Unmarshal(refreshed["errors"], &failures) != nil || len(failures) != 0 {
			return errors.New("codex_marketplace_refresh_failed")
		}
		if err := phase("installing"); err != nil {
			return err
		}
		added, err = codex("plugin", "add", "logic-margin@logic-margin-local", "--json")
		if err != nil {
			return err
		}
		var plugin struct{ Name, MarketplaceName, Version, InstalledPath string }
		b, _ := json.Marshal(added)
		if json.Unmarshal(b, &plugin) != nil || plugin.Name != "logic-margin" || plugin.MarketplaceName != "logic-margin-local" || plugin.Version != job.Version || !filepath.IsAbs(plugin.InstalledPath) {
			return errors.New("codex_installation_unverified")
		}
		manifest, err := os.ReadFile(filepath.Join(plugin.InstalledPath, "plugin.json"))
		if err != nil {
			return errors.New("codex_installation_unverified")
		}
		var metadata struct{ Name, Version string }
		if json.Unmarshal(manifest, &metadata) != nil || metadata.Name != "logic-margin" || metadata.Version != job.Version {
			return errors.New("codex_installation_unverified")
		}
		status.InstalledVersion = plugin.Version
		status.ReloadRequired = true
		return phase("restarting")
	}, func(ctx context.Context) error {
		if err := phase("restoring"); err != nil {
			return err
		}
		return restoreData(ctx, filepath.Join(directory, "backup"), job.DataDir, filepath.Join(directory, "failed-data"))
	})
	if err != nil {
		return err
	}
	if err := phase("verifying"); err != nil {
		return err
	}
	actual, err := daemon.Status(ctx, job.Home, job.Version)
	if err != nil {
		return err
	}
	if actual["running"] != true || actual["compatible"] != true || actual["version"] != job.Version {
		return errors.New("restart_unverified")
	}
	status.Phase = "completed"
	return nil
}

// Keep the executable lookup in the worker-independent service startup path.
func CodexAvailable() bool { _, err := exec.LookPath("codex"); return err == nil }
