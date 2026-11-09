package daemon

import "os"

func publishLock(from, to string) error { return os.Rename(from, to) }
