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
