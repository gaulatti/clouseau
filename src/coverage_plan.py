"""Verify separate native application coverage artifacts without merging reports."""

import contextlib
import io
import json
from pathlib import Path
import sys

from check_coverage import counters, enforce, load_report


def _path(directory, value, *, source=False):
    if source and value == ".":
        return directory
    if (not isinstance(value, str) or not value or len(value) >= 500
            or "\\" in value or "\0" in value or Path(value).is_absolute()
            or any(part in ("", ".", "..", ".git") for part in value.split("/"))):
        raise ValueError("Coverage paths must be explicit repository-relative paths")
    target = (directory / value).resolve()
    if not target.is_relative_to(directory):
        raise ValueError("Coverage paths cannot escape the application checkout")
    return target


def measure_plan(parts, directory="."):
    """Measure every native part; incomplete percentages are valid evidence."""
    if not isinstance(parts, list) or not parts or len(parts) > 32:
        raise ValueError("A coverage plan requires one to 32 native artifact parts")
    directory = Path(directory).resolve()
    reports = set()
    roots = []
    plan = []
    for part in parts:
        if (not isinstance(part, dict) or set(part) != {"format", "report", "source_directory"}
                or part["format"] not in ("istanbul", "coveragepy")):
            raise ValueError("Each coverage part requires a supported native format, report and source_directory")
        report = _path(directory, part["report"])
        source = _path(directory, part["source_directory"], source=True)
        if not source.is_dir():
            raise ValueError("Every coverage part requires an existing application source directory")
        if report in reports or any(source.is_relative_to(root) or root.is_relative_to(source) for root in roots):
            raise ValueError("Duplicate reports or overlapping application source directories are not allowed")
        reports.add(report)
        roots.append(source)
        plan.append((part, report, source))

    totals = {"lines": [0, 0], "branches": [0, 0]}
    results = []
    for part, report, source in plan:
        with contextlib.chdir(directory):
            measured = counters(load_report(report), source, part["format"])
        if measured["lines"][0] == 0:
            raise ValueError("Every coverage part requires nonempty application line counters")
        for metric in totals:
            total, covered = measured[metric]
            totals[metric][0] += total
            totals[metric][1] += covered
        results.append({**part, "counts": measured})
    return {"totals": totals, "parts": results}


def check_plan(parts, directory="."):
    result = measure_plan(parts, directory)
    for part in result["parts"]:
        for metric, (total, covered) in part["counts"].items():
            if total != covered:
                raise ValueError(f"{part['report']} has uncovered {metric}; require exactly 100% for every part")
    # A genuinely branchless component is valid only alongside measured branches.
    with contextlib.redirect_stdout(io.StringIO()):
        enforce(result["totals"])
    return result


def main(argv):
    if len(argv) not in (1, 2):
        raise ValueError("Usage: coverage_plan.py ACCEPTED_CONFIG [APPLICATION_DIRECTORY]")
    config = load_report(argv[0])
    if not isinstance(config, dict) or config.get("version") != 2:
        raise ValueError("A multi-artifact coverage recipe requires version 2")
    if set(config) - {"version", "base_branch", "readme", "repository_policy", "verification", "coverage"}:
        raise ValueError("Unknown version 2 coverage recipe field")
    result = check_plan(config.get("coverage"), argv[1] if len(argv) == 2 else ".")
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"Coverage gate failed: {error}", file=sys.stderr)
        sys.exit(1)
