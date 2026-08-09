package main

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"
)

// Logging is intentionally minimal: the probe runs as a service and its output
// is captured by systemd, the Windows event log or launchd. Structured logging
// would add a dependency for no benefit at this scale.

var verboseEnabled atomic.Bool

func setVerbose(on bool) { verboseEnabled.Store(on) }

func logAt(level, format string, args ...any) {
	stamp := time.Now().Format("2006-01-02 15:04:05")
	fmt.Fprintf(os.Stderr, "%s [%s] %s\n", stamp, level, fmt.Sprintf(format, args...))
}

func logInfo(format string, args ...any)  { logAt("INFO", format, args...) }
func logWarn(format string, args ...any)  { logAt("WARN", format, args...) }
func logError(format string, args ...any) { logAt("ERROR", format, args...) }

func logDebug(format string, args ...any) {
	if verboseEnabled.Load() {
		logAt("DEBUG", format, args...)
	}
}
