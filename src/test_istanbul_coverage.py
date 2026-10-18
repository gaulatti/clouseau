import contextlib
import copy
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

from check_coverage import check


class IstanbulGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name, "src")
        self.root.mkdir()
        self.file = self.root / "service.ts"
        self.file.write_text("export function f(ok: boolean) {\n  return ok ? 1 : 0;\n}\n")
        name = str(self.file)
        self.report = {name: {"path": name,
            "statementMap": {"0": {"start": {"line": 1}}, "1": {"start": {"line": 2}}},
            "s": {"0": 1, "1": 2},
            "branchMap": {"0": {"locations": [{}, {}]}}, "b": {"0": [1, 1]}}}

    def run_check(self, value=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return check(self.report if value is None else value, self.root, "istanbul")

    def test_native_counters_and_duplicate_line_locations(self):
        self.assertEqual(self.run_check(), {"lines": [2, 2], "branches": [2, 2]})
        entry = self.report[str(self.file)]
        entry["statementMap"]["2"] = {"start": {"line": 2}}
        entry["s"]["2"] = 0
        self.assertEqual(self.run_check(), {"lines": [2, 2], "branches": [2, 2]})

    def test_exact_hits_not_rounded_percentages(self):
        for metric in ("s", "b"):
            value = copy.deepcopy(self.report)
            value[str(self.file)][metric]["0"] = 0 if metric == "s" else [1000000, 0]
            with self.subTest(metric=metric), self.assertRaisesRegex(ValueError, "1 uncovered"):
                self.run_check(value)

    def test_unloaded_omitted_sources_cannot_disappear(self):
        (self.root / "unloaded.ts").write_text("export const unloaded = 1;\n")
        with self.assertRaisesRegex(ValueError, "Missing application source.*unloaded.ts"):
            self.run_check()

    def test_declaration_files_and_non_code_do_not_add_executable_sources(self):
        (self.root / "types.d.ts").write_text("declare const x: number;\n")
        (self.root / "README.md").write_text("Documentation\n")
        self.assertEqual(self.run_check()["lines"], [2, 2])

    def test_external_sources_do_not_replace_application_sources(self):
        external = str(self.root.parent / "dependency.js")
        self.report[external] = {"path": external}
        self.assertEqual(self.run_check()["lines"], [2, 2])
        del self.report[str(self.file)]
        with self.assertRaisesRegex(ValueError, "Missing application source"):
            self.run_check()

    def test_no_sources_or_empty_measurements_fail(self):
        self.file.unlink()
        with self.assertRaisesRegex(ValueError, "No application JS/TS sources"):
            self.run_check()
        self.file.touch()
        for keys in (("statementMap", "s"), ("branchMap", "b")):
            value = copy.deepcopy(self.report)
            for key in keys:
                value[str(self.file)][key] = {}
            with self.subTest(keys=keys), self.assertRaisesRegex(ValueError, "No .* measured"):
                self.run_check(value)

    def test_ignore_directives_and_skip_flags_fail(self):
        for tool in ("c8", "istanbul", "v8"):
            self.file.write_text(f"/* {tool} ignore next */\nexport const hidden = 1;\n")
            with self.subTest(tool=tool), self.assertRaisesRegex(ValueError, "ignore directives"):
                self.run_check()
        self.file.write_text("export const visible = 1;\n")
        for location in ("statementMap", "branchMap"):
            value = copy.deepcopy(self.report)
            value[str(self.file)][location]["0"]["skip"] = True
            with self.subTest(location=location), self.assertRaisesRegex(ValueError, "skipped"):
                self.run_check(value)

    def test_unexpected_duplicate_and_mismatched_paths_fail(self):
        value = copy.deepcopy(self.report)
        value[str(self.file.with_suffix(".js"))] = {}
        with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
            self.run_check(value)
        alias = str(self.root / "alias.ts")
        Path(alias).symlink_to(self.file)
        value = copy.deepcopy(self.report)
        value[alias] = {**value[str(self.file)], "path": alias}
        with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
            self.run_check(value)
        for entry in (None, {"path": "wrong.ts"}):
            with self.subTest(entry=entry), self.assertRaisesRegex(ValueError, "Mismatched"):
                self.run_check({str(self.file): entry})

    def test_malformed_maps_hits_and_locations_fail(self):
        for value in ({}, []):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "nonempty Istanbul"):
                self.run_check(value)
        mutations = [("statementMap", None), ("s", None), ("s", {}),
                     ("branchMap", None), ("b", None), ("b", {})]
        mutations += [("statementMap", {"0": loc, "1": {"start": {"line": 2}}})
                      for loc in (None, {}, {"start": {"line": 0}}, {"start": {"line": True}})]
        mutations += [("branchMap", {"0": loc}) for loc in (None, {}, {"locations": None})]
        mutations += [("b", {"0": values}) for values in (None, [], [1], [True, 1], [-1, 1], ["1", 1])]
        mutations += [("s", {"0": hit, "1": 1}) for hit in (True, -1, "1")]
        for key, replacement in mutations:
            value = copy.deepcopy(self.report)
            value[str(self.file)][key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(ValueError):
                self.run_check(value)

    def test_cli_selects_native_format_and_unknown_formats_fail_closed(self):
        script = str(Path(__file__).with_name("check_coverage.py"))
        report = self.root.parent / "coverage.json"
        report.write_text(json.dumps(self.report))
        with patch.object(sys, "argv", [script, str(report), str(self.root), "istanbul"]), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(script, run_name="__main__")
        with self.assertRaisesRegex(ValueError, "Unknown coverage format"):
            check(self.report, self.root, "percentages")


if __name__ == "__main__":
    unittest.main()
