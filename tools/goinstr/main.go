// Command goinstr measures Go executable lines and branch outcomes by rewriting application sources into an
// overlay (go test -overlay) whose counters write each taken outcome to disk at the moment it is taken.
//
//	goinstr instrument -module DIR -work DIR [-goos OS] [-goarch ARCH] [-tags a,b]
//	goinstr report -out FILE -run WORKDIR [-run WORKDIR ...]
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	schema       = "clouseau-go-outcomes"
	manifestName = "manifest.json"
	coverFile    = "zz_clouseau_cover.go"
)

type Build struct {
	GOOS   string   `json:"goos"`
	GOARCH string   `json:"goarch"`
	Tags   []string `json:"tags"`
}

type packageHits struct {
	Index int `json:"index"`
	Count int `json:"count"`
}

type fileEntry struct {
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	Lines   int    `json:"lines"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Package int    `json:"package"`
	Units   []Unit `json:"units"`
}

type manifest struct {
	Schema    string        `json:"schema"`
	GoVersion string        `json:"go_version"`
	Module    string        `json:"module"`
	Build     Build         `json:"build"`
	Packages  []packageHits `json:"packages"`
	Files     []fileEntry   `json:"files"`
}

type listedPackage struct {
	Dir            string
	ImportPath     string
	Name           string
	GoFiles        []string
	CgoFiles       []string
	IgnoredGoFiles []string
	Error          *struct{ Err string }
	Module         *struct {
		Path      string
		Dir       string
		GoVersion string
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "goinstr:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: goinstr instrument|report ...")
	}
	switch args[0] {
	case "instrument":
		return runInstrument(args[1:])
	case "report":
		return runReport(args[1:])
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func goOutput(dir string, env []string, args ...string) ([]byte, error) {
	command := exec.Command("go", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), env...)
	var stderr strings.Builder
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("go %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func goEnv(dir, name string, env []string) (string, error) {
	out, err := goOutput(dir, env, "env", name)
	return strings.TrimSpace(string(out)), err
}

func versionAtLeast(version string, major, minor int) bool {
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return false
	}
	a, errA := strconv.Atoi(parts[0])
	b, errB := strconv.Atoi(parts[1])
	return errA == nil && errB == nil && (a > major || a == major && b >= minor)
}

var excludedDirectories = map[string]bool{"vendor": true, "testdata": true, "node_modules": true}

// inventory lists every production .go file of the module, with the same exclusions the Node adapter applies.
func inventory(root string) ([]string, error) {
	var files []string
	var walk func(directory string) error
	walk = func(directory string) error {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			path := filepath.Join(directory, name)
			switch {
			case entry.Type()&os.ModeSymlink != 0:
				if strings.HasSuffix(name, ".go") {
					return fmt.Errorf("symbolic Go source: %s", path)
				}
			case entry.IsDir():
				if _, nested := os.Stat(filepath.Join(path, "go.mod")); strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") ||
					excludedDirectories[name] || nested == nil {
					continue
				}
				if err := walk(path); err != nil {
					return err
				}
			case strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go"):
				files = append(files, path)
			}
		}
		return nil
	}
	return files, walk(root)
}

func runInstrument(args []string) (failure error) {
	flags := flag.NewFlagSet("instrument", flag.ContinueOnError)
	moduleFlag := flags.String("module", ".", "module root")
	workFlag := flags.String("work", "", "work directory for the overlay, manifest and hits")
	goos := flags.String("goos", "", "GOOS (default: go env)")
	goarch := flags.String("goarch", "", "GOARCH (default: go env)")
	tagsFlag := flags.String("tags", "", "comma-separated build tags")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *workFlag == "" {
		return errors.New("-work is required")
	}
	logical, err := filepath.Abs(*moduleFlag)
	if err != nil {
		return err
	}
	root, err := filepath.EvalSymlinks(logical)
	if err != nil {
		return err
	}
	work, err := filepath.Abs(*workFlag)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(work); err == nil && !info.IsDir() {
		return fmt.Errorf("work path %s exists and is not a directory", work)
	}
	if entries, err := os.ReadDir(work); err == nil && len(entries) > 0 {
		if !ownDirectory(work, entries) {
			return fmt.Errorf("work directory %s is not empty and not a goinstr directory", work)
		}
		if err := os.RemoveAll(work); err != nil {
			return err
		}
	}
	defer func() {
		if failure != nil {
			os.RemoveAll(work)
		}
	}()
	var env []string
	if *goos != "" {
		env = append(env, "GOOS="+*goos)
	}
	if *goarch != "" {
		env = append(env, "GOARCH="+*goarch)
	}
	build := Build{Tags: []string{}}
	if *tagsFlag != "" {
		build.Tags = strings.Split(*tagsFlag, ",")
		sort.Strings(build.Tags)
	}
	if build.GOOS, err = goEnv(root, "GOOS", env); err != nil {
		return err
	}
	if build.GOARCH, err = goEnv(root, "GOARCH", env); err != nil {
		return err
	}
	version, err := goEnv(root, "GOVERSION", env)
	if err != nil {
		return err
	}
	listArgs := []string{"list", "-e", "-json"}
	if len(build.Tags) > 0 {
		listArgs = append(listArgs, "-tags="+strings.Join(build.Tags, ","))
	}
	listed, err := goOutput(root, env, append(listArgs, "./...")...)
	if err != nil {
		return err
	}
	packages, err := decodePackages(listed)
	if err != nil {
		return err
	}
	m := &manifest{Schema: schema, GoVersion: version, Build: build}
	overlay := map[string]string{}
	ignored := map[string]bool{}
	sort.Slice(packages, func(i, j int) bool { return packages[i].ImportPath < packages[j].ImportPath })
	for _, pkg := range packages {
		if pkg.Module == nil || pkg.Module.Dir != root {
			return fmt.Errorf("package %s is outside the module at %s", pkg.ImportPath, root)
		}
		if m.Module != "" && m.Module != pkg.Module.Path {
			return errors.New("packages from more than one module")
		}
		m.Module = pkg.Module.Path
		if !versionAtLeast(pkg.Module.GoVersion, 1, 18) {
			return fmt.Errorf("go.mod must declare go 1.18 or newer (found %q): the counters use generics", pkg.Module.GoVersion)
		}
		if len(pkg.CgoFiles) > 0 {
			return fmt.Errorf("package %s uses cgo, which is not supported", pkg.ImportPath)
		}
		if pkg.Error != nil && !(len(pkg.GoFiles) == 0 && len(pkg.IgnoredGoFiles) > 0) {
			return fmt.Errorf("package %s: %s", pkg.ImportPath, strings.TrimSpace(pkg.Error.Err))
		}
		for _, name := range pkg.IgnoredGoFiles {
			ignored[filepath.Join(pkg.Dir, name)] = true
		}
		if len(pkg.GoFiles) > 0 {
			if err := instrumentPackage(m, work, overlay, pkg, [2]string{root, logical}); err != nil {
				return err
			}
		}
	}
	files, err := inventory(root)
	if err != nil {
		return err
	}
	have := map[string]bool{}
	for _, entry := range m.Files {
		have[entry.Path] = true
	}
	for _, file := range files {
		relative, _ := filepath.Rel(root, file)
		relative = filepath.ToSlash(relative)
		if have[relative] {
			continue
		}
		reason := "not part of any package loaded by go list"
		if ignored[file] {
			reason = fmt.Sprintf("excluded by build constraints for goos=%s goarch=%s tags=[%s]", build.GOOS, build.GOARCH, strings.Join(build.Tags, ","))
		}
		entry, err := describe(root, relative)
		if err != nil {
			return err
		}
		entry.Status, entry.Reason, entry.Units = "inactive", reason, []Unit{}
		m.Files = append(m.Files, entry)
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	if err := os.MkdirAll(filepath.Join(work, "hits"), 0o755); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(work, "overlay.json"), map[string]any{"Replace": overlay}); err != nil {
		return err
	}
	return writeJSON(filepath.Join(work, manifestName), m)
}

func decodePackages(data []byte) ([]listedPackage, error) {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	var packages []listedPackage
	for decoder.More() {
		var pkg listedPackage
		if err := decoder.Decode(&pkg); err != nil {
			return nil, err
		}
		packages = append(packages, pkg)
	}
	if len(packages) == 0 {
		return nil, errors.New("go list found no packages")
	}
	return packages, nil
}

func describe(root, relative string) (fileEntry, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return fileEntry{}, err
	}
	sum := sha256.Sum256(data)
	lines := strings.Count(string(data), "\n")
	if len(data) > 0 && data[len(data)-1] != '\n' {
		lines++
	}
	return fileEntry{Path: relative, SHA256: hex.EncodeToString(sum[:]), Lines: lines}, nil
}

func instrumentPackage(m *manifest, work string, overlay map[string]string, pkg listedPackage, roots [2]string) error {
	index := len(m.Packages)
	next := 0
	root := pkg.Module.Dir
	names := append([]string(nil), pkg.GoFiles...)
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join(pkg.Dir, name)
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		entry, err := describe(root, relative)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out, units, err := instrument(relative, data, &next)
		if err != nil {
			return err
		}
		target := filepath.Join(work, "src", fmt.Sprintf("%d-%s", index, name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, out, 0o644); err != nil {
			return err
		}
		overlayAdd(overlay, path, target, roots)
		entry.Status, entry.Package, entry.Units = "measured", index, units
		m.Files = append(m.Files, entry)
	}
	cover := filepath.Join(pkg.Dir, coverFile)
	if _, err := os.Stat(cover); err == nil {
		return fmt.Errorf("%s already exists", cover)
	}
	target := filepath.Join(work, "src", fmt.Sprintf("%d-%s", index, coverFile))
	hits := filepath.Join(work, "hits", fmt.Sprintf("%d.hit", index))
	if err := os.WriteFile(target, []byte(coverSource(pkg.Name, hits, next)), 0o644); err != nil {
		return err
	}
	overlayAdd(overlay, cover, target, roots)
	m.Packages = append(m.Packages, packageHits{Index: index, Count: next})
	return nil
}

// coverSource is the per-package runtime. A first hit of a counter is written at once with pwrite, so a taken
// outcome survives os.Exit, a crash and a recovered panic, and several test binaries may share one file.
func coverSource(name, hits string, count int) string {
	size := count
	if size == 0 {
		size = 1
	}
	return fmt.Sprintf(`// Code generated by clouseau goinstr. DO NOT EDIT.

package %s

import (
	clouseauos "os"
	clouseausync "sync"
	clouseauatomic "sync/atomic"
)

const clouseauHitsPath = %q

var (
	clouseauSeen [%d]uint32
	clouseauMu   clouseausync.Mutex
	clouseauFile *clouseauos.File
)

func clouseauHit(id int) {
	if clouseauatomic.CompareAndSwapUint32(&clouseauSeen[id], 0, 1) && !clouseauRecord(id) {
		clouseauatomic.StoreUint32(&clouseauSeen[id], 0)
	}
}

func clouseauRecord(id int) bool {
	clouseauMu.Lock()
	defer clouseauMu.Unlock()
	if clouseauFile == nil {
		file, err := clouseauos.OpenFile(clouseauHitsPath, clouseauos.O_WRONLY|clouseauos.O_CREATE, 0o644)
		if err != nil {
			clouseauos.Stderr.WriteString("clouseau goinstr: " + err.Error() + "\n")
			return false
		}
		clouseauFile = file
	}
	if _, err := clouseauFile.WriteAt([]byte{1}, int64(id)); err != nil {
		clouseauos.Stderr.WriteString("clouseau goinstr: " + err.Error() + "\n")
		return false
	}
	return true
}

func clouseauB[T ~bool](taken, other int, value T) T {
	if value {
		clouseauHit(taken)
	} else {
		clouseauHit(other)
	}
	return value
}
`, name, hits, size)
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

// overlayAdd maps a source to its replacement under the module path go list reports and under the path the shell may
// use for the same directory (a symbolic link such as macOS /var), because go matches the overlay by the path it sees.
func overlayAdd(overlay map[string]string, path, target string, roots [2]string) {
	overlay[path] = target
	if roots[0] != roots[1] {
		if relative, err := filepath.Rel(roots[0], path); err == nil {
			overlay[filepath.Join(roots[1], relative)] = target
		}
	}
}

// ownDirectory is true only for a directory goinstr wrote: its manifest carries the goinstr schema and nothing else is in it.
func ownDirectory(work string, entries []os.DirEntry) bool {
	data, err := os.ReadFile(filepath.Join(work, manifestName))
	var m manifest
	if err != nil || json.Unmarshal(data, &m) != nil || m.Schema != schema {
		return false
	}
	for _, entry := range entries {
		switch entry.Name() {
		case manifestName, "overlay.json", "src", "hits":
		default:
			return false
		}
	}
	return true
}
