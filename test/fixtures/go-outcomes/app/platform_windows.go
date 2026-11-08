//go:build windows

package app

// Windows only exists in a windows build.
func Windows() bool { return true }
