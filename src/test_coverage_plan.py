import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

from coverage_plan import check_plan, main
from test_coveragepy_coverage import native_report


class CoveragePlanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.parts = [self.javascript("backend", branches=True), self.javascript("frontend", branches=False)]

    def javascript(self, name, branches):
        root = self.root / name
        root.mkdir()
        filename = str(root / "service.js")
        Path(filename).write_text("module.exports = value => value ? 1 : 0;\n" if branches else "module.exports = 1;\n")
        report = {filename: {"path": filename, "statementMap": {"0": {"start": {"line": 1}}},
                            "s": {"0": 1}, "branchMap": {"0": {"locations": [{}, {}]}} if branches else {},
                            "b": {"0": [1, 1]} if branches else {}}}
        (self.root / f"{name}.json").write_text(json.dumps(report))
        return {"format": "istanbul", "report": f"{name}.json", "source_directory": name}

    def mutate(self, name, change):
        filename = self.root / f"{name}.json"
        value = json.loads(filename.read_text())
        change(next(iter(value.values())))
        filename.write_text(json.dumps(value))

    def test_native_parts_retain_individual_counts_and_require_complete_aggregate(self):
        measured = check_plan(self.parts, self.root)
        self.assertEqual(measured["totals"], {"lines": [2, 2], "branches": [2, 2]})
        self.assertEqual(measured["parts"][0], {**self.parts[0], "counts": {"lines": [1, 1], "branches": [2, 2]}})
        self.assertEqual(measured["parts"][1]["counts"]["branches"], [0, 0])
        self.mutate("backend", lambda entry: entry["b"]["0"].__setitem__(1, 0))
        with self.assertRaisesRegex(ValueError, "backend.json has uncovered branches"):
            check_plan(self.parts, self.root)

    def test_native_coveragepy_and_istanbul_use_the_same_plan_without_combined_artifacts(self):
        report = native_report(self.root / "python")
        (self.root / "python.json").write_text(json.dumps(report))
        python = {"format": "coveragepy", "report": "python.json", "source_directory": "python"}
        measured = check_plan([python, self.parts[1]], self.root)
        self.assertEqual(measured["totals"], {"lines": [5, 5], "branches": [2, 2]})
        self.assertEqual(measured["parts"][0]["counts"], {"lines": [4, 4], "branches": [2, 2]})

    def test_one_complete_part_cannot_mask_another_missing_or_uncovered_part(self):
        self.mutate("frontend", lambda entry: entry["s"].__setitem__("0", 0))
        with self.assertRaisesRegex(ValueError, "frontend.json has uncovered lines"):
            check_plan(self.parts, self.root)
        (self.root / "frontend" / "unloaded.js").write_text("module.exports = 2;\n")
        with self.assertRaisesRegex(ValueError, "Missing application source.*unloaded.js"):
            check_plan(self.parts, self.root)
        (self.root / "frontend.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "nonempty Istanbul"):
            check_plan(self.parts, self.root)

    def test_empty_lines_or_an_entirely_branchless_plan_never_pass(self):
        self.mutate("frontend", lambda entry: (entry.__setitem__("statementMap", {}), entry.__setitem__("s", {})))
        with self.assertRaisesRegex(ValueError, "Every coverage part requires nonempty"):
            check_plan(self.parts, self.root)
        self.mutate("backend", lambda entry: (entry.__setitem__("branchMap", {}), entry.__setitem__("b", {})))
        with self.assertRaisesRegex(ValueError, "No branches measured"):
            check_plan(self.parts[:1], self.root)
        for child in (self.root / "frontend").iterdir():
            child.unlink()
        (self.root / "frontend" / "service.test.js").write_text("test('fixture', () => {});\n")
        with self.assertRaisesRegex(ValueError, "No application JS/TS"):
            check_plan(self.parts, self.root)

    def test_invalid_plan_shape_format_and_ignored_policy_fields_fail(self):
        values = [None, {}, [], "not a plan", self.parts * 17,
                  [None], [{}], [{**self.parts[0], "format": "go"}],
                  [{**self.parts[0], "format": "llvm"}], [{**self.parts[0], "exclude": ["hidden.js"]}]]
        for value in values:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "coverage plan|coverage part"):
                check_plan(value, self.root)

    def test_duplicate_reports_and_overlapping_roots_are_rejected_before_counting(self):
        for parts in [self.parts[:1] * 2,
                      [self.parts[0], {**self.parts[1], "report": "backend.json"}],
                      [self.parts[0], {**self.parts[1], "source_directory": "backend"}]]:
            with self.subTest(parts=parts), self.assertRaisesRegex(ValueError, "Duplicate reports or overlapping"):
                check_plan(parts, self.root)
        (self.root / "backend" / "nested").mkdir()
        nested = {**self.parts[1], "source_directory": "backend/nested"}
        for parts in [[self.parts[0], nested], [nested, self.parts[0]]]:
            with self.subTest(parts=parts), self.assertRaisesRegex(ValueError, "overlapping"):
                check_plan(parts, self.root)
        (self.root / "alias.json").symlink_to(self.root / "backend.json")
        with self.assertRaisesRegex(ValueError, "Duplicate reports"):
            check_plan([self.parts[0], {**self.parts[1], "report": "alias.json"}], self.root)

    def test_repository_relative_boundaries_do_not_follow_escaped_sources_or_reports(self):
        for field in ("report", "source_directory"):
            for value in (None, "", "/outside", "../outside", "folder//file", "./file", "folder\\file", "file\0", "x" * 500):
                invalid = [{**self.parts[0], field: value}]
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "repository-relative"):
                    check_plan(invalid, self.root)
        with self.assertRaisesRegex(ValueError, "existing application"):
            check_plan([{**self.parts[0], "source_directory": "missing"}], self.root)
        with tempfile.TemporaryDirectory() as outside:
            (self.root / "escaped").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escape the application"):
                check_plan([{**self.parts[0], "source_directory": "escaped"}], self.root)
            with self.assertRaisesRegex(ValueError, "escape the application"):
                check_plan([{**self.parts[0], "report": "escaped/report.json"}], self.root)

    def test_strict_native_loader_rejects_duplicate_json_keys(self):
        source = str(self.root / "backend" / "service.js")
        (self.root / "backend.json").write_text(json.dumps({source: {}})[:-1] + "," + json.dumps(source) + ":{}}")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            check_plan(self.parts, self.root)

    def test_ci_entrypoint_reads_accepted_recipe_as_data_without_running_its_commands(self):
        filename = self.root / "accepted.json"
        filename.write_text(json.dumps({"version": 2, "coverage": self.parts,
                                       "verification": [["must-never-execute-from-coverage"]]}))
        with contextlib.redirect_stdout(io.StringIO()) as output:
            measured = main([str(filename), str(self.root)])
        self.assertEqual(json.loads(output.getvalue()), measured)
        with contextlib.chdir(self.root), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main([str(filename)])["totals"], measured["totals"])
        with patch.object(sys, "argv", ["coverage_plan.py", str(filename), str(self.root)]), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_module("coverage_plan", run_name="__main__")
        for value in ({"version": 1, "coverage": self.parts[0]}, [], {"version": 2, "coverage": []}):
            filename.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaises(ValueError):
                main([str(filename)])
        for argv in ([], [str(filename)] * 3):
            with self.subTest(argv=argv), self.assertRaisesRegex(ValueError, "Usage"):
                main(argv)
        with patch.object(sys, "argv", ["coverage_plan.py"]), contextlib.redirect_stderr(io.StringIO()) as error:
            with self.assertRaises(SystemExit) as exit_value:
                runpy.run_module("coverage_plan", run_name="__main__")
        self.assertEqual(exit_value.exception.code, 1)
        self.assertIn("Coverage gate failed", error.getvalue())


if __name__ == "__main__":
    unittest.main()
