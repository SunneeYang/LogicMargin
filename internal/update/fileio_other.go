//go:build !windows

package update

func retryUpdateFileIO(operation func() error) error { return operation() }
