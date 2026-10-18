"""Require exact, nonempty application line and branch coverage."""

import json
from pathlib import Path
import sys

from istanbul_coverage import counters as istanbul_counters


def check(report, source_directory="src", coverage_format="llvm"):
    if coverage_format == "istanbul":
        return enforce(istanbul_counters(report, source_directory))
    if coverage_format != "llvm":
        raise ValueError("Unknown coverage format; use llvm or istanbul")
    if report.get("type") != "llvm.coverage.json.export":
        raise ValueError("Expected an LLVM coverage export")
    data = report.get("data")
    if not isinstance(data, list) or not data:
        raise ValueError("Coverage data is missing")
    counts = {metric: [0, 0] for metric in ("lines", "branches")}
    source_files = 0
    for group in data:
        files = group.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError("Per-file coverage is missing")
        for file in files:
            filename = file.get("filename", "")
            parts = Path(filename).parts
            if "vendor" in parts or ".cargo" in parts:
                continue
            try:
                Path(filename).resolve().relative_to(Path(source_directory).resolve())
            except ValueError:
                continue
            source_files += 1
            for metric in counts:
                summary = file.get("summary", {}).get(metric, {})
                count, covered = summary.get("count"), summary.get("covered")
                if type(count) is not int or type(covered) is not int:
                    raise ValueError(f"Missing integer {metric} counts: {filename}")
                if count < 0 or not 0 <= covered <= count:
                    raise ValueError(f"Invalid {metric} counts: {filename}")
                counts[metric][0] += count
                counts[metric][1] += covered
    if not source_files:
        raise ValueError("No application source coverage was measured")
    return enforce(counts)


def enforce(counts):
    failures = []
    for metric, (count, covered) in counts.items():
        print(f"{metric}: {covered}/{count}")
        if count == 0:
            failures.append(f"No {metric} measured")
        elif count != covered:
            failures.append(f"{metric}: {count - covered} uncovered; require exactly 100%")
    if failures:
        raise ValueError("; ".join(failures))
    return counts


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (3, 4):
            raise ValueError("Usage: check_coverage.py REPORT SOURCE_DIRECTORY [llvm|istanbul]")
        check(json.loads(Path(sys.argv[1]).read_text()), sys.argv[2],
              sys.argv[3] if len(sys.argv) == 4 else "llvm")
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"Coverage gate failed: {error}", file=sys.stderr)
        sys.exit(1)
