"""Validate native coverage.py JSON decision exits and complete Python sources."""

import ast
from collections import Counter
import io
from pathlib import Path
import re
import tokenize


DEPENDENCY_DIRECTORIES = {".git", ".venv", "venv", ".tox", ".nox", "__pycache__", "node_modules"}


def production_python(relative):
    """Exclude concrete test and dependency conventions, never application globs."""
    return not (
        set(relative.parts[:-1]) & (DEPENDENCY_DIRECTORIES | {"test", "tests"})
        or relative.name in {"tests.py", "conftest.py"}
        or relative.name.startswith("test_")
        or relative.name.endswith("_test.py")
    )


def source_inventory(root):
    sources = {}
    for file in root.rglob("*.py"):
        if not production_python(file.relative_to(root)):
            continue
        if file.is_symlink() or not file.resolve().is_relative_to(root):
            raise ValueError(f"Symbolic or escaped Python application source: {file}")
        with tokenize.open(file) as stream:
            text = stream.read()
        try:
            tree = ast.parse(text, filename=str(file))
            comments = [token.string for token in tokenize.generate_tokens(io.StringIO(text).readline)
                        if token.type == tokenize.COMMENT]
        except (SyntaxError, tokenize.TokenError) as error:
            raise ValueError(f"Invalid Python application source: {file}") from error
        if any(re.search(r"^#\s*pragma\s*:?\s*no\s*(?:cover|branch)", comment, re.I)
               for comment in comments):
            raise ValueError(f"Coverage ignore directives are not allowed: {file}")
        executable = any(not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                              and isinstance(node.value.value, str)) for node in tree.body)
        sources[file.resolve()] = (len(text.splitlines()), executable)
    if not sources:
        raise ValueError("No application Python sources found")
    return sources


def line_set(value, limit):
    if not isinstance(value, list) or any(type(line) is not int or not 1 <= line <= limit for line in value):
        raise ValueError("Invalid coverage.py line numbers")
    if len(set(value)) != len(value):
        raise ValueError("Duplicate coverage.py line numbers")
    return set(value)


def arc_set(value, limit):
    if not isinstance(value, list):
        raise ValueError("Missing coverage.py branch decision exits")
    arcs = set()
    for arc in value:
        if (not isinstance(arc, list) or len(arc) != 2 or any(type(line) is not int for line in arc)
                or not 1 <= arc[0] <= limit or arc[1] == 0 or not -limit <= arc[1] <= limit
                or arc[0] == arc[1]):
            raise ValueError("Invalid coverage.py branch decision exit")
        pair = tuple(arc)
        if pair in arcs:
            raise ValueError("Duplicate coverage.py branch decision exit")
        arcs.add(pair)
    return arcs


def native_counts(entry, source):
    if not isinstance(entry, dict):
        raise ValueError("Missing coverage.py file measurements")
    limit, executable = source
    executed = line_set(entry.get("executed_lines"), limit)
    missing = line_set(entry.get("missing_lines"), limit)
    excluded = line_set(entry.get("excluded_lines"), limit)
    if excluded:
        raise ValueError("Excluded Python application lines are not allowed")
    if executed & missing or executable and not (executed | missing):
        raise ValueError("Inconsistent or empty executable Python line measurements")
    taken = arc_set(entry.get("executed_branches"), limit)
    untaken = arc_set(entry.get("missing_branches"), limit)
    exits = taken | untaken
    if (taken & untaken or any(origin not in executed for origin, _ in taken)
            or any(origin not in executed | missing for origin, _ in untaken)
            or any(total < 2 for total in Counter(origin for origin, _ in exits).values())):
        raise ValueError("Inconsistent coverage.py branch decision exits")
    summary = entry.get("summary")
    if (not isinstance(summary, dict)
            or any(type(summary.get(key)) is not int for key in ("num_statements", "covered_lines"))
            or not 0 <= summary["covered_lines"] <= len(executed)
            or summary["num_statements"] != summary["covered_lines"] + len(missing)
            or executable and summary["num_statements"] == 0):
        raise ValueError("Coverage.py native summary disagrees with executable line measurements")
    expected = {
        "missing_lines": len(missing), "excluded_lines": 0,
        "covered_branches": len(taken), "num_branches": len(exits),
        "missing_branches": len(untaken),
        "num_partial_branches": sum(origin in executed for origin, _ in untaken),
    }
    if any(type(summary.get(key)) is not int or summary[key] != count for key, count in expected.items()):
        raise ValueError("Coverage.py native summary disagrees with exact line/branch measurements")
    return {"lines": [summary["num_statements"], summary["covered_lines"]],
            "branches": [len(exits), len(taken)]}


def counters(report, source_directory):
    root = Path(source_directory).resolve()
    sources = source_inventory(root)
    meta = report.get("meta") if isinstance(report, dict) else None
    if (not isinstance(meta, dict) or type(meta.get("format")) is not int or meta["format"] != 3
            or meta.get("branch_coverage") is not True or not isinstance(meta.get("version"), str)
            or not meta["version"]):
        raise ValueError("Expected branch-aware native coverage.py JSON format 3")
    files = report.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Missing native coverage.py file measurements")
    counts = {metric: [0, 0] for metric in ("lines", "branches")}
    seen = set()
    for filename, entry in files.items():
        if not isinstance(filename, str) or not filename or ".." in Path(filename).parts:
            raise ValueError("Unsafe coverage.py source path")
        file = Path(filename)
        if not file.is_absolute():
            file = root / file if (root / file).exists() else file
        if file.is_symlink():
            raise ValueError("Symbolic coverage.py source path")
        file = file.resolve()
        if not file.is_relative_to(root):
            continue
        if file not in sources or file in seen:
            raise ValueError(f"Unexpected or duplicate Python application coverage: {filename}")
        seen.add(file)
        measured = native_counts(entry, sources[file])
        for metric in counts:
            counts[metric] = [left + right for left, right in zip(counts[metric], measured[metric])]
    if seen != set(sources):
        raise ValueError("Missing application Python source coverage: " + ", ".join(map(str, set(sources) - seen)))
    return counts
