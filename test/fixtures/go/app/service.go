package app

// Choose returns one for a truthy value and zero otherwise.
func Choose(ok bool) int {
	if ok {
		return 1
	}
	return 0
}

// Both has a short-circuit operand.
func Both(a, b bool) bool {
	return a && b
}
