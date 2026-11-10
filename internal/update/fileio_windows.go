package update

import (
	"errors"
	"time"

	"golang.org/x/sys/windows"
)

func retryUpdateFileIO(operation func() error) error {
	deadline := time.Now().Add(250 * time.Millisecond)
	for {
		err := operation()
		// Readers and atomic replacement can briefly deny each other's Windows sharing modes.
		if (!errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION)) || !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
}
