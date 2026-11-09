package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"time"
)

// Replace keeps start.lock throughout backup, installation and verified restart.
// Prepare and Restore run with the data writer lock held and no service running.
func Replace(ctx context.Context, home, instanceID, dataDir, version, binary, fallback string, prepare func(context.Context) error, restore func(context.Context) error) error {
	release, err := AcquireLock(ctx, filepath.Join(home, "start.lock"), 10*time.Second)
	if err != nil {
		return err
	}
	defer release()
	entry, err := registry(home)
	if err != nil {
		return err
	}
	if entry == nil || entry.InstanceID != instanceID || !sameInstance(entry, health(ctx, entry.URL)) {
		return errors.New("registered_instance_changed")
	}
	if entry.DataDir == "" || !filepath.IsAbs(entry.DataDir) || entry.DataDir != dataDir {
		return errors.New("unknown_data_directory")
	}
	u, _ := url.Parse(entry.URL)
	port, _ := strconv.Atoi(u.Port())
	opts := Options{Home: home, Host: entry.Host, Port: &port, DataDir: entry.DataDir, Version: entry.Version, Command: []string{fallback}, RequireMCP: true}
	rollback := func(cause error, restoreData bool) error {
		recovery, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if restoreData {
			unlock, lockErr := AcquireLock(recovery, filepath.Join(entry.DataDir, ".service-lock"), 5*time.Second)
			if lockErr != nil {
				return fmt.Errorf("%w; rollback_blocked: %v", cause, lockErr)
			}
			restoreErr := restore(recovery)
			_ = unlock()
			if restoreErr != nil {
				return fmt.Errorf("%w; restore_failed: %v", cause, restoreErr)
			}
		}
		if _, startErr := spawn(recovery, home, opts); startErr != nil {
			return fmt.Errorf("%w; rollback_failed: %v", cause, startErr)
		}
		return fmt.Errorf("%w; old_service_restored", cause)
	}
	// Once shutdown is requested, finish identifying its outcome even if the user cancels.
	stopping, finishStop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	_, stopErr := stop(stopping, home)
	finishStop()
	if stopErr != nil {
		if ProcessAlive(entry.PID) {
			return stopErr
		}
		return rollback(stopErr, false)
	}
	unlock, err := AcquireLock(ctx, filepath.Join(entry.DataDir, ".service-lock"), 5*time.Second)
	if err != nil {
		return rollback(err, false)
	}
	err = prepare(ctx)
	unlockErr := unlock()
	if err != nil {
		return rollback(err, false)
	}
	if unlockErr != nil {
		return rollback(unlockErr, false)
	}
	if err := ctx.Err(); err != nil {
		return rollback(err, false)
	}
	opts.Version, opts.Command = version, []string{binary}
	if _, err := spawn(ctx, home, opts); err != nil {
		// spawn kills and waits for its own failed child; lock acquisition prevents overlap even if it survived.
		opts.Version, opts.Command = entry.Version, []string{fallback}
		return rollback(err, true)
	}
	return nil
}
