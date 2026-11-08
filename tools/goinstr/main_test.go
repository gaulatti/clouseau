package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const fixtureApp = "../../test/fixtures/go-outcomes/app"

func copyTree(t *testing.T, from string) string {
	t.Helper()
	to := t.TempDir()
	err := filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(from, path)
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(to, relative), 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(to, relative), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return to
}

func command(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	c := exec.Command(name, args...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
	return string(out)
}

// measure instruments a copy of the module, runs the selected tests against the overlay and returns the report.
func measure(t *testing.T, module string, pattern string, extra ...string) report {
	t.Helper()
	work := filepath.Join(t.TempDir(), "work")
	if err := run(append([]string{"instrument", "-module", module, "-work", work}, extra...)); err != nil {
		t.Fatal(err)
	}
	command(t, module, "go", "test", "-count=1", "-run", pattern, "-overlay="+filepath.Join(work, "overlay.json"), "./...")
	return build(t, filepath.Join(t.TempDir(), "report.json"), work)
}

func build(t *testing.T, out string, works ...string) report {
	t.Helper()
	args := []string{"report", "-out", out}
	for _, work := range works {
		args = append(args, "-run", work)
	}
	if err := run(args); err != nil {
		t.Fatal(err)
	}
	var result report
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func file(t *testing.T, r report, path string) reportFile {
	t.Helper()
	for _, f := range r.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("%s missing from the report", path)
	return reportFile{}
}

func outcomes(t *testing.T, r report, line int, construct, outcome string) []int {
	t.Helper()
	var hits []int
	for _, o := range file(t, r, "decide.go").Outcomes {
		if o.Line == line && o.Construct == construct && o.Outcome == outcome {
			hits = append(hits, o.Hits)
		}
	}
	if len(hits) == 0 {
		t.Fatalf("no %s %s outcome on line %d", construct, outcome, line)
	}
	return hits
}

func statement(t *testing.T, r report, line int) int {
	t.Helper()
	total, count := 0, 0
	for _, s := range file(t, r, "decide.go").Statements {
		if s.Line == line {
			total, count = total+s.Hits, count+1
		}
	}
	if count == 0 {
		t.Fatalf("no statement on line %d", line)
	}
	return total
}

func expect(t *testing.T, what string, got []int, want ...int) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %v want %v", what, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: got %v want %v", what, got, want)
		}
	}
}

func TestImplicitFalseAndElseIf(t *testing.T) {
	module := copyTree(t, fixtureApp)
	negative := measure(t, module, "^TestSignNegative$")
	expect(t, "if true", outcomes(t, negative, 5, "if", "true"), 1)
	expect(t, "if false", outcomes(t, negative, 5, "if", "false"), 0)
	expect(t, "else-if untouched", outcomes(t, negative, 7, "if", "true"), 0)
	positive := measure(t, module, "^TestSignPositive$")
	expect(t, "implicit false of the else-if", outcomes(t, positive, 7, "if", "false"), 1)
	expect(t, "else-if true", outcomes(t, positive, 7, "if", "true"), 0)
}

func TestShortCircuitOperandsAreSeparateOutcomes(t *testing.T) {
	module := copyTree(t, fixtureApp)
	first := measure(t, module, "^TestBothFirstFalse$")
	hit := 0
	for _, o := range file(t, first, "decide.go").Outcomes {
		if o.Line == 14 && o.Construct == "operand" {
			hit += o.Hits
			if o.Hits == 1 && o.Outcome != "false" {
				t.Fatalf("the first operand should only be false: %+v", o)
			}
		}
	}
	if hit != 1 {
		t.Fatalf("a false first operand must not record the second operand, got %d hits", hit)
	}
	all := measure(t, module, "^TestBoth")
	for _, o := range file(t, all, "decide.go").Outcomes {
		if o.Line == 14 && o.Construct == "operand" && o.Hits != 1 {
			t.Fatalf("every operand outcome should be taken: %+v", o)
		}
	}
}

func TestSwitchTypeSwitchAndSelectOutcomes(t *testing.T) {
	module := copyTree(t, fixtureApp)
	matched := measure(t, module, "^TestGradeA$|^TestKindInt$|^TestNamedOne$|^TestReceiveDefault$")
	expect(t, "switch no-match", outcomes(t, matched, 30, "switch", "no-match"), 0)
	expect(t, "typeswitch no-match", outcomes(t, matched, 41, "typeswitch", "no-match"), 0)
	expect(t, "default", outcomes(t, matched, 55, "switch", "default"), 0)
	expect(t, "select case not ready", outcomes(t, matched, 102, "select", "case@102:2"), 0)
	expect(t, "select default", outcomes(t, matched, 104, "select", "default"), 1)
	unmatched := measure(t, module, "^TestGradeNoMatch$|^TestKindNoMatch$|^TestNamedDefault$")
	expect(t, "switch no-match", outcomes(t, unmatched, 30, "switch", "no-match"), 1)
	expect(t, "typeswitch no-match", outcomes(t, unmatched, 41, "typeswitch", "no-match"), 1)
	expect(t, "default", outcomes(t, unmatched, 55, "switch", "default"), 1)
}

func TestLoopZeroEntry(t *testing.T) {
	module := copyTree(t, fixtureApp)
	entered := measure(t, module, "^TestTotalNonEmpty$|^TestCountLoop$")
	expect(t, "range enter", outcomes(t, entered, 63, "range", "enter"), 1)
	expect(t, "range zero-entry", outcomes(t, entered, 63, "range", "zero-entry"), 0)
	expect(t, "for entered", outcomes(t, entered, 72, "for", "true"), 1)
	expect(t, "for exit", outcomes(t, entered, 72, "for", "false"), 1)
	expect(t, "for zero-entry", outcomes(t, entered, 72, "for", "zero-entry"), 0)
	empty := measure(t, module, "^TestTotalEmpty$|^TestCountZero$")
	expect(t, "range enter", outcomes(t, empty, 63, "range", "enter"), 0)
	expect(t, "range zero-entry", outcomes(t, empty, 63, "range", "zero-entry"), 1)
	expect(t, "for entered", outcomes(t, empty, 72, "for", "true"), 0)
	expect(t, "for zero-entry", outcomes(t, empty, 72, "for", "zero-entry"), 1)
}

func TestEarlyExitLeavesLaterStatementsUnhit(t *testing.T) {
	module := copyTree(t, fixtureApp)
	stopped := measure(t, module, "^TestEarlyStop$")
	if statement(t, stopped, 123) != 1 || statement(t, stopped, 125) != 0 {
		t.Fatal("only the early return should have run")
	}
	expect(t, "if false", outcomes(t, stopped, 122, "if", "false"), 0)
}

func TestRecoveredPanicIsNotInferred(t *testing.T) {
	module := copyTree(t, fixtureApp)
	recovered := measure(t, module, "^TestRecovered$")
	if statement(t, recovered, 112) != 1 || statement(t, recovered, 113) != 1 {
		t.Fatal("the statements before the panic ran")
	}
	if statement(t, recovered, 114) != 0 || statement(t, recovered, 115) != 0 {
		t.Fatal("the statements after the recovered panic did not run")
	}
	// Go's own profile reports the whole block, including the statement that never ran, as covered.
	profile := filepath.Join(t.TempDir(), "cover.out")
	command(t, module, "go", "test", "-count=1", "-run", "^TestRecovered$", "-coverprofile="+profile, ".")
	data, _ := os.ReadFile(profile)
	if !strings.Contains(string(data), "decide.go:112.2,115.15 4 1") {
		t.Fatalf("expected a standard profile block for Recovered:\n%s", data)
	}
}

func TestFullSuiteLeavesOnlyUnreachedUnitsAndFlagsUnloadedAndInactiveFiles(t *testing.T) {
	module := copyTree(t, fixtureApp)
	full := measure(t, module, ".")
	for _, o := range file(t, full, "decide.go").Outcomes {
		if o.Hits != 1 {
			t.Fatalf("every outcome should be taken by the full suite: %+v", o)
		}
	}
	unloaded := file(t, full, "unloaded/unloaded.go")
	if unloaded.Status != "measured" || len(unloaded.Statements) == 0 || len(unloaded.Outcomes) == 0 {
		t.Fatalf("an unloaded package must be inventoried: %+v", unloaded)
	}
	for _, s := range unloaded.Statements {
		if s.Hits != 0 {
			t.Fatal("an unloaded package has no hits")
		}
	}
	windows := file(t, full, "platform_windows.go")
	if windows.Status != "inactive" || !strings.Contains(windows.Reason, "build constraints") {
		t.Fatalf("a build-constrained file is explicit: %+v", windows)
	}
}

func TestBuildsAndShardsAreAggregated(t *testing.T) {
	module := copyTree(t, fixtureApp)
	temporary := t.TempDir()
	one, two, win := filepath.Join(temporary, "one"), filepath.Join(temporary, "two"), filepath.Join(temporary, "win")
	for _, work := range []string{one, two} {
		if err := run([]string{"instrument", "-module", module, "-work", work}); err != nil {
			t.Fatal(err)
		}
	}
	if err := run([]string{"instrument", "-module", module, "-work", win, "-goos", "windows", "-goarch", "amd64"}); err != nil {
		t.Fatal(err)
	}
	command(t, module, "go", "test", "-count=1", "-run", "^TestSignNegative$", "-overlay="+filepath.Join(one, "overlay.json"), ".")
	command(t, module, "go", "test", "-count=1", "-run", "^TestSignZero$", "-overlay="+filepath.Join(two, "overlay.json"), ".")
	cross := exec.Command("go", "build", "-overlay="+filepath.Join(win, "overlay.json"), "./...")
	cross.Dir = module
	cross.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64")
	if out, err := cross.CombinedOutput(); err != nil {
		t.Fatalf("the windows overlay must compile: %v\n%s", err, out)
	}
	merged := build(t, filepath.Join(temporary, "r.json"), one, two, win)
	expect(t, "first shard", outcomes(t, merged, 5, "if", "true"), 1)
	expect(t, "second shard", outcomes(t, merged, 7, "if", "true"), 1)
	if len(merged.Builds) != 3 {
		t.Fatalf("every build is recorded: %+v", merged.Builds)
	}
	windows := file(t, merged, "platform_windows.go")
	if windows.Status != "measured" || len(windows.Statements) == 0 || windows.Statements[0].Hits != 0 {
		t.Fatalf("a file active in one declared build is measured: %+v", windows)
	}
}

func TestUnsupportedAndInvalidInputsFail(t *testing.T) {
	module := copyTree(t, fixtureApp)
	work := filepath.Join(t.TempDir(), "work")
	if err := os.WriteFile(filepath.Join(module, "init.go"), []byte("package app\n\nvar ready = Both(true, true) && Both(true, false)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"instrument", "-module", module, "-work", work}); err == nil || !strings.Contains(err.Error(), "outside a function body") {
		t.Fatalf("a package-level short circuit is an explicit error: %v", err)
	}
	os.Remove(filepath.Join(module, "init.go"))
	old := filepath.Join(module, "go.mod")
	data, _ := os.ReadFile(old)
	os.WriteFile(old, []byte(strings.Replace(string(data), "go 1.21", "go 1.17", 1)), 0o644)
	if err := run([]string{"instrument", "-module", module, "-work", work}); err == nil || !strings.Contains(err.Error(), "go 1.18") {
		t.Fatalf("an old go.mod is an explicit error: %v", err)
	}
	os.WriteFile(old, data, 0o644)
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(work, "keep.txt"), []byte("x"), 0o644)
	if err := run([]string{"instrument", "-module", module, "-work", work}); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatalf("a foreign work directory is never removed: %v", err)
	}
	// A directory that merely has a manifest.json of its own is never removed either.
	os.WriteFile(filepath.Join(work, "manifest.json"), []byte(`{"schema":"other"}`), 0o644)
	if err := run([]string{"instrument", "-module", module, "-work", work}); err == nil {
		t.Fatal("a foreign manifest must not authorize removal")
	}
	if _, err := os.Stat(filepath.Join(work, "keep.txt")); err != nil {
		t.Fatal("the foreign directory was touched")
	}
	os.Remove(filepath.Join(work, "keep.txt"))
	os.Remove(filepath.Join(work, "manifest.json"))
	if err := run([]string{"instrument", "-module", module, "-work", work}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"instrument", "-module", module, "-work", work}); err != nil {
		t.Fatalf("a goinstr directory is reusable: %v", err)
	}
	for _, args := range [][]string{{}, {"nothing"}, {"report"}, {"instrument"}} {
		if run(args) == nil {
			t.Fatalf("%v should fail", args)
		}
	}
}
