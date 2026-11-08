package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"strconv"
)

// Unit is one required measurement: an executed statement (executable line) or one outcome of a decision.
type Unit struct {
	ID        int    `json:"id"`
	Kind      string `json:"kind"` // "statement" or "outcome"
	Line      int    `json:"line"`
	Construct string `json:"construct,omitempty"`
	Group     string `json:"group,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
}

type edit struct {
	offset int
	text   string
	closes bool
	seq    int
}

type rewriter struct {
	fset  *token.FileSet
	file  *ast.File
	name  string
	next  *int
	units []Unit
	edits []edit
	chain map[ast.Node]bool
	errs  []error
}

func (r *rewriter) offset(pos token.Pos) int { return r.fset.PositionFor(pos, false).Offset }
func (r *rewriter) line(pos token.Pos) int   { return r.fset.PositionFor(pos, false).Line }
func (r *rewriter) at(pos token.Pos) string {
	p := r.fset.PositionFor(pos, false)
	return strconv.Itoa(p.Line) + ":" + strconv.Itoa(p.Column)
}

func (r *rewriter) fail(pos token.Pos, message string) {
	r.errs = append(r.errs, fmt.Errorf("%s:%d: %s", r.name, r.line(pos), message))
}

func (r *rewriter) insert(offset int, text string) {
	r.edits = append(r.edits, edit{offset: offset, text: text, seq: len(r.edits)})
}

func (r *rewriter) closer(offset int, text string) {
	r.edits = append(r.edits, edit{offset: offset, text: text, closes: true, seq: len(r.edits)})
}

func (r *rewriter) unit(kind string, pos token.Pos, construct, group, outcome string) int {
	id := *r.next
	*r.next++
	r.units = append(r.units, Unit{ID: id, Kind: kind, Line: r.line(pos), Construct: construct, Group: group, Outcome: outcome})
	return id
}

// hit records the outcome at the point the inserted code runs.
func (r *rewriter) hit(offset int, pos token.Pos, construct, group, outcome string) {
	r.insert(offset, "clouseauHit("+strconv.Itoa(r.unit("outcome", pos, construct, group, outcome))+");")
}

// decide wraps a boolean expression so that the value it produces records which outcome it took, in place and
// without changing evaluation order.
func (r *rewriter) decide(expr ast.Expr, construct, group string) {
	t := r.unit("outcome", expr.Pos(), construct, group, "true")
	f := r.unit("outcome", expr.Pos(), construct, group, "false")
	r.insert(r.offset(expr.Pos()), fmt.Sprintf("clouseauB(%d,%d,", t, f))
	r.closer(r.offset(expr.End()), ")")
}

func leaves(expr ast.Expr, out *[]ast.Expr, chain map[ast.Node]bool) {
	switch e := expr.(type) {
	case *ast.ParenExpr:
		leaves(e.X, out, chain)
	case *ast.BinaryExpr:
		if e.Op == token.LAND || e.Op == token.LOR {
			chain[e] = true
			leaves(e.X, out, chain)
			leaves(e.Y, out, chain)
			return
		}
		*out = append(*out, expr)
	default:
		*out = append(*out, expr)
	}
}

func (r *rewriter) statementList(list []ast.Stmt) {
	for _, stmt := range list {
		switch stmt.(type) {
		case *ast.EmptyStmt, *ast.CaseClause, *ast.CommClause:
			continue
		}
		r.insert(r.offset(stmt.Pos()), "clouseauHit("+strconv.Itoa(r.unit("statement", stmt.Pos(), "", "", ""))+");")
		inner := stmt
		if labeled, ok := stmt.(*ast.LabeledStmt); ok {
			inner = labeled.Stmt
		}
		switch loop := inner.(type) {
		case *ast.RangeStmt:
			r.zeroEntry(stmt, loop.For, loop.Body, "range")
		case *ast.ForStmt:
			if loop.Cond != nil {
				r.zeroEntry(stmt, loop.For, loop.Body, "for")
				r.decide(loop.Cond, "for", r.at(loop.For))
			}
		}
	}
}

// zeroEntry reports a loop that finished without ever starting an iteration. The flag lives in a block around the
// loop, so `break` and `continue` keep their targets and the loop keeps its own scope.
func (r *rewriter) zeroEntry(stmt ast.Stmt, forPos token.Pos, body *ast.BlockStmt, construct string) {
	flag := "clouseauZ" + strconv.Itoa(*r.next)
	r.insert(r.offset(stmt.Pos()), "{var "+flag+" = true;")
	r.insert(r.offset(body.Lbrace)+1, flag+"=false;")
	if construct == "range" {
		r.hit(r.offset(body.Lbrace)+1, forPos, construct, r.at(forPos), "enter")
	}
	id := r.unit("outcome", forPos, construct, r.at(forPos), "zero-entry")
	r.closer(r.offset(stmt.End()), ";if "+flag+" {clouseauHit("+strconv.Itoa(id)+")}}")
}

func (r *rewriter) clauses(body *ast.BlockStmt, construct string, hasDefault func(ast.Stmt) bool, addDefault bool) {
	group := r.at(body.Lbrace)
	defaulted := false
	for _, stmt := range body.List {
		var colon token.Pos
		switch clause := stmt.(type) {
		case *ast.CaseClause:
			colon = clause.Colon
		case *ast.CommClause:
			colon = clause.Colon
		}
		outcome := "case@" + r.at(stmt.Pos())
		if hasDefault(stmt) {
			outcome, defaulted = "default", true
		}
		r.hit(r.offset(colon)+1, stmt.Pos(), construct, group, outcome)
	}
	if addDefault && !defaulted {
		id := r.unit("outcome", body.Lbrace, construct, group, "no-match")
		r.insert(r.offset(body.Rbrace), "default:clouseauHit("+strconv.Itoa(id)+");")
	}
}

func (r *rewriter) walk() {
	var stack []ast.Node
	ast.Inspect(r.file, func(node ast.Node) bool {
		if node == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		stack = append(stack, node)
		switch n := node.(type) {
		case *ast.BlockStmt:
			r.statementList(n.List)
		case *ast.CaseClause:
			r.statementList(n.Body)
		case *ast.CommClause:
			r.statementList(n.Body)
		case *ast.IfStmt:
			r.decide(n.Cond, "if", r.at(n.If))
		case *ast.SwitchStmt:
			r.clauses(n.Body, "switch", func(s ast.Stmt) bool { return s.(*ast.CaseClause).List == nil }, true)
		case *ast.TypeSwitchStmt:
			r.clauses(n.Body, "typeswitch", func(s ast.Stmt) bool { return s.(*ast.CaseClause).List == nil }, true)
		case *ast.SelectStmt:
			r.clauses(n.Body, "select", func(s ast.Stmt) bool { return s.(*ast.CommClause).Comm == nil }, false)
		case *ast.BinaryExpr:
			if (n.Op == token.LAND || n.Op == token.LOR) && !r.chain[n] {
				r.operands(n, stack)
			}
		}
		return true
	})
}

func (r *rewriter) operands(root *ast.BinaryExpr, stack []ast.Node) {
	inBlock, inConst := false, false
	for _, parent := range stack {
		if _, ok := parent.(*ast.BlockStmt); ok {
			inBlock = true
		}
		if decl, ok := parent.(*ast.GenDecl); ok && decl.Tok == token.CONST {
			inConst = true
		}
	}
	if !inBlock || inConst {
		r.fail(root.Pos(), "short-circuit operator outside a function body or in a constant is not supported")
		return
	}
	var found []ast.Expr
	leaves(root, &found, r.chain)
	for _, leaf := range found {
		r.decide(leaf, "operand", r.at(leaf.Pos()))
	}
}

// instrument returns the rewritten source and the units it measures. Lines are unchanged: insertions never add
// a newline.
func instrument(name string, src []byte, next *int) ([]byte, []Unit, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, name, src, parser.ParseComments)
	if err != nil {
		return nil, nil, err
	}
	r := &rewriter{fset: fset, file: file, name: name, next: next, chain: map[ast.Node]bool{}}
	r.walk()
	if len(r.errs) > 0 {
		return nil, nil, r.errs[0]
	}
	return apply(src, r.edits), r.units, nil
}

func apply(src []byte, edits []edit) []byte {
	sort.SliceStable(edits, func(i, j int) bool {
		a, b := edits[i], edits[j]
		if a.offset != b.offset {
			return a.offset < b.offset
		}
		if a.closes != b.closes {
			return a.closes
		}
		if a.closes {
			return a.seq > b.seq
		}
		return a.seq < b.seq
	})
	var out []byte
	last := 0
	for _, e := range edits {
		out = append(out, src[last:e.offset]...)
		out = append(out, e.text...)
		last = e.offset
	}
	return append(out, src[last:]...)
}
