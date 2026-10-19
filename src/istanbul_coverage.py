"""Read native Istanbul counters and require a complete JS/TS source inventory."""

from pathlib import Path
import re


def counters(report, source_directory):
    root = Path(source_directory).resolve()
    sources = {file.resolve() for file in root.rglob("*")
               if file.is_file() and file.suffix in {".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"}
               and not file.name.endswith(".d.ts")}
    if not sources:
        raise ValueError("No application JS/TS sources found")
    for file in sources:
        if re.search(r"\b(?:c8|istanbul|v8)\s+ignore\b", file.read_text()):
            raise ValueError(f"Coverage ignore directives are not allowed: {file}")
    if not isinstance(report, dict) or not report:
        raise ValueError("Expected a nonempty Istanbul coverage map")
    seen = set()
    counts = {metric: [0, 0] for metric in ("lines", "branches")}
    for filename, entry in report.items():
        file = Path(filename).resolve()
        if not file.is_relative_to(root):
            continue
        if file not in sources or file in seen:
            raise ValueError(f"Unexpected or duplicate application coverage: {filename}")
        if not isinstance(entry, dict) or entry.get("path") != filename:
            raise ValueError(f"Mismatched Istanbul source path: {filename}")
        seen.add(file)
        statements = paired_maps(entry, "statementMap", "s")
        branches = paired_maps(entry, "branchMap", "b")
        if not statements:
            raise ValueError(f"No statements measured for application source: {filename}")
        lines = {}
        for key, location in statements.items():
            if not isinstance(location, dict) or location.get("skip"):
                raise ValueError("Invalid or skipped statement")
            line = location.get("start", {}).get("line")
            if type(line) is not int or line < 1:
                raise ValueError("Invalid Istanbul source line")
            lines[line] = max(lines.get(line, 0), hit(entry["s"][key]))
        branch_hits = []
        for key, location in branches.items():
            values = entry["b"][key]
            if (not isinstance(location, dict) or location.get("skip") or
                    not isinstance(location.get("locations"), list) or
                    not isinstance(values, list) or not values or
                    len(values) != len(location["locations"])):
                raise ValueError("Invalid or skipped branch measurement")
            branch_hits.extend(hit(value) for value in values)
        for metric, values in (("lines", list(lines.values())), ("branches", branch_hits)):
            counts[metric][0] += len(values)
            counts[metric][1] += sum(value > 0 for value in values)
    missing = sources - seen
    if missing:
        raise ValueError("Missing application source coverage: " + ", ".join(str(file) for file in sorted(missing)))
    return counts


def paired_maps(entry, locations, hits):
    if (not isinstance(entry.get(locations), dict) or not isinstance(entry.get(hits), dict)
            or entry[locations].keys() != entry[hits].keys()):
        raise ValueError(f"Missing or inconsistent Istanbul {locations}/{hits}")
    return entry[locations]


def hit(value):
    if type(value) is not int or value < 0:
        raise ValueError("Coverage hits must be nonnegative integers")
    return value
