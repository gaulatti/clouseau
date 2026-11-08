package app

import "testing"

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSignNegative(t *testing.T) { eq(t, Sign(-1), "negative") }
func TestSignZero(t *testing.T)     { eq(t, Sign(0), "zero") }
func TestSignPositive(t *testing.T) { eq(t, Sign(1), "positive") }

func TestBothFirstFalse(t *testing.T) { eq(t, Both(false, true), false) }
func TestBothSecond(t *testing.T) {
	eq(t, Both(true, true), true)
	eq(t, Both(true, false), false)
}

func TestEitherFirstTrue(t *testing.T) { eq(t, Either(true, false), true) }
func TestEitherSecond(t *testing.T) {
	eq(t, Either(false, true), true)
	eq(t, Either(false, false), false)
}

func TestFlag(t *testing.T) {
	eq(t, Flag(true).On(true), Flag(true))
	eq(t, Flag(false).On(true), Flag(false))
	eq(t, Flag(true).On(false), Flag(false))
}

func TestGradeA(t *testing.T)       { eq(t, Grade(95), "A") }
func TestGradeB(t *testing.T)       { eq(t, Grade(85), "B") }
func TestGradeNoMatch(t *testing.T) { eq(t, Grade(10), "?") }

func TestKindInt(t *testing.T)     { eq(t, Kind(1), "int") }
func TestKindString(t *testing.T)  { eq(t, Kind("x"), "string") }
func TestKindNoMatch(t *testing.T) { eq(t, Kind(1.5), "other") }

func TestNamedOne(t *testing.T)     { eq(t, Named(1), "one") }
func TestNamedDefault(t *testing.T) { eq(t, Named(2), "many") }

func TestTotalNonEmpty(t *testing.T) { eq(t, Total([]int{1, 2}), 3) }
func TestTotalEmpty(t *testing.T)    { eq(t, Total(nil), 0) }

func TestCountLoop(t *testing.T) { eq(t, Count(2), 2) }
func TestCountZero(t *testing.T) { eq(t, Count(0), 0) }

func TestSkip(t *testing.T) {
	eq(t, Skip([][]int{{1, -1, 2}, {3}}), 2)
	eq(t, Skip(nil), 0)
	eq(t, Skip([][]int{{}}), 0)
}

func TestReceiveReady(t *testing.T) {
	ready := make(chan int, 1)
	ready <- 7
	eq(t, Receive(ready, true), 7)
	ready <- 8
	eq(t, Receive(ready, false), 8)
}

func TestReceiveDefault(t *testing.T) { eq(t, Receive(make(chan int), false), -1) }

func TestRecovered(t *testing.T) { eq(t, Recovered(), 1) }

func TestEarlyStop(t *testing.T) { eq(t, Early(true), 0) }
func TestEarlyRun(t *testing.T)  { eq(t, Early(false), 1) }
