package daemon

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func publishLock(from, to string) error { return os.Rename(from, to) }

func lockRemovalBusy(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

func lockProbeBusy(err error) bool { return errors.Is(err, windows.ERROR_SHARING_VIOLATION) }

func lockPublishBusy(err error) bool { return lockRemovalBusy(err) }
