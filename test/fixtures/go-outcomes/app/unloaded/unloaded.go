// Package unloaded is imported by no test.
package unloaded

func Unused(n int) int {
	if n > 0 {
		return 1
	}
	return 0
}
