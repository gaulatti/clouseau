package app

// Sign has an if with no else: the false outcome is implicit.
func Sign(n int) string {
	if n < 0 {
		return "negative"
	} else if n == 0 {
		return "zero"
	}
	return "positive"
}

// Both and Either use short-circuit operands that are separate outcomes.
func Both(a, b bool) bool { return a && b }

func Either(a, b bool) bool {
	if a || b {
		return true
	}
	return false
}

type Flag bool

// On decides over a named boolean type.
func (f Flag) On(g Flag) Flag { return f && g }

// Grade is a switch without default: no match is an outcome.
func Grade(n int) string {
	switch {
	case n >= 90:
		return "A"
	case n >= 80:
		return "B"
	}
	return "?"
}

// Kind is a type switch without default.
func Kind(v any) string {
	switch v.(type) {
	case int:
		return "int"
	case string:
		return "string"
	}
	return "other"
}

// Named is a switch with an explicit default.
func Named(n int) string {
	switch n {
	case 1:
		return "one"
	default:
		return "many"
	}
}

// Total ranges over a slice: an empty slice never enters the body.
func Total(values []int) int {
	sum := 0
	for _, value := range values {
		sum += value
	}
	return sum
}

// Count is a conditional loop.
func Count(limit int) int {
	steps := 0
	for steps < limit {
		steps++
	}
	return steps
}

// Skip uses a labeled loop with continue.
func Skip(rows [][]int) int {
	kept := 0
outer:
	for _, row := range rows {
		for _, value := range row {
			if value < 0 {
				continue outer
			}
			kept++
		}
	}
	return kept
}

// Receive selects among channels, with and without default.
func Receive(ready chan int, wait bool) int {
	if wait {
		select {
		case value := <-ready:
			return value
		}
	}
	select {
	case value := <-ready:
		return value
	default:
		return -1
	}
}

// Recovered panics after the first assignment and recovers; the second assignment never runs.
func Recovered() (result int) {
	defer func() { _ = recover() }()
	result = 1
	explode()
	result = 2
	return result
}

func explode() { panic("boom") }

// Early returns before its last statement.
func Early(stop bool) int {
	if stop {
		return 0
	}
	return 1
}
