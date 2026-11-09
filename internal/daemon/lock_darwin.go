package daemon

import "golang.org/x/sys/unix"

func publishLock(from, to string) error { return unix.RenamexNp(from, to, unix.RENAME_EXCL) }

func lockRemovalBusy(error) bool { return false }
func lockProbeBusy(error) bool   { return false }
func lockPublishBusy(error) bool { return false }
