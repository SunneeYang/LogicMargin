package daemon

import "golang.org/x/sys/unix"

func publishLock(from, to string) error {
	return unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
}

func lockRemovalBusy(error) bool { return false }
func lockProbeBusy(error) bool   { return false }
