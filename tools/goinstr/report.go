package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type statementHit struct {
	Line int `json:"line"`
	Hits int `json:"hits"`
}

type outcomeHit struct {
	Line      int    `json:"line"`
	Construct string `json:"construct"`
	Group     string `json:"group"`
	Outcome   string `json:"outcome"`
	Hits      int    `json:"hits"`
}

type reportFile struct {
	Path       string         `json:"path"`
	SHA256     string         `json:"sha256"`
	Lines      int            `json:"lines"`
	Status     string         `json:"status"`
	Reason     string         `json:"reason,omitempty"`
	Statements []statementHit `json:"statements"`
	Outcomes   []outcomeHit   `json:"outcomes"`
}

type report struct {
	Schema    string       `json:"schema"`
	Version   int          `json:"version"`
	GoVersion string       `json:"go_version"`
	Module    string       `json:"module"`
	Builds    []Build      `json:"builds"`
	Files     []reportFile `json:"files"`
}

type runFlags []string

func (r *runFlags) String() string     { return strings.Join(*r, ",") }
func (r *runFlags) Set(v string) error { *r = append(*r, v); return nil }

func runReport(args []string) error {
	flags := flag.NewFlagSet("report", flag.ContinueOnError)
	out := flags.String("out", "", "report file to write")
	var runs runFlags
	flags.Var(&runs, "run", "work directory of one instrumented run (repeat for builds or shards)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *out == "" || len(runs) == 0 {
		return errors.New("-out and at least one -run are required")
	}
	result := report{Schema: schema, Version: 1}
	byPath := map[string]*reportFile{}
	for _, work := range runs {
		data, err := os.ReadFile(filepath.Join(work, manifestName))
		if err != nil {
			return err
		}
		var m manifest
		if err := json.Unmarshal(data, &m); err != nil || m.Schema != schema {
			return fmt.Errorf("%s is not a goinstr manifest", work)
		}
		if result.Module != "" && (result.Module != m.Module || result.GoVersion != m.GoVersion) {
			return errors.New("runs differ in module or Go version")
		}
		result.Module, result.GoVersion = m.Module, m.GoVersion
		result.Builds = append(result.Builds, m.Build)
		hits := map[int][]byte{}
		for _, p := range m.Packages {
			bytes, err := os.ReadFile(filepath.Join(work, "hits", fmt.Sprintf("%d.hit", p.Index)))
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			hits[p.Index] = bytes
		}
		for _, entry := range m.Files {
			if err := merge(byPath, entry, hits[entry.Package]); err != nil {
				return err
			}
		}
	}
	for _, file := range byPath {
		result.Files = append(result.Files, *file)
	}
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return os.WriteFile(*out, append(data, '\n'), 0o644)
}

func hitAt(hits []byte, id int) int {
	if id < len(hits) && hits[id] == 1 {
		return 1
	}
	return 0
}

func merge(byPath map[string]*reportFile, entry fileEntry, hits []byte) error {
	current := reportFile{Path: entry.Path, SHA256: entry.SHA256, Lines: entry.Lines, Status: entry.Status, Reason: entry.Reason,
		Statements: []statementHit{}, Outcomes: []outcomeHit{}}
	for _, u := range entry.Units {
		if u.Kind == "statement" {
			current.Statements = append(current.Statements, statementHit{Line: u.Line, Hits: hitAt(hits, u.ID)})
		} else {
			current.Outcomes = append(current.Outcomes, outcomeHit{Line: u.Line, Construct: u.Construct, Group: u.Group, Outcome: u.Outcome, Hits: hitAt(hits, u.ID)})
		}
	}
	known, ok := byPath[entry.Path]
	if !ok {
		byPath[entry.Path] = &current
		return nil
	}
	if known.SHA256 != current.SHA256 {
		return fmt.Errorf("%s differs between runs", entry.Path)
	}
	if known.Status == "inactive" {
		if current.Status == "inactive" && !strings.Contains(known.Reason, current.Reason) {
			known.Reason += "; " + current.Reason
		} else if current.Status == "measured" {
			*known = current
		}
		return nil
	}
	if current.Status == "inactive" {
		return nil
	}
	if len(known.Statements) != len(current.Statements) || len(known.Outcomes) != len(current.Outcomes) {
		return fmt.Errorf("%s was instrumented differently between runs", entry.Path)
	}
	for i := range known.Statements {
		if known.Statements[i].Line != current.Statements[i].Line {
			return fmt.Errorf("%s was instrumented differently between runs", entry.Path)
		}
		known.Statements[i].Hits |= current.Statements[i].Hits
	}
	for i := range known.Outcomes {
		a, b := &known.Outcomes[i], current.Outcomes[i]
		if a.Line != b.Line || a.Construct != b.Construct || a.Group != b.Group || a.Outcome != b.Outcome {
			return fmt.Errorf("%s was instrumented differently between runs", entry.Path)
		}
		a.Hits |= b.Hits
	}
	return nil
}
