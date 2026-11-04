package util

// Pick selects a label.
func Pick(n int) string {
	switch n {
	case 1:
		return "one"
	default:
		return "many"
	}
}
