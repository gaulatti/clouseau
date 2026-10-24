import contextlib
import copy
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from check_coverage import check, counters, load_report
from coveragepy_coverage import source_inventory


SOURCE = "def choose(ok):\n    if ok:\n        return 1\n    return 0\n"


def native_report(root, driver="import service; service.choose(True); service.choose(False)", branch=True,
                  config=None, source=SOURCE):
    """Use the actual coverage.py command, not handcrafted passing counters."""
    root.mkdir(exist_ok=True)
    (root / "service.py").write_text(source)
    (root / "__init__.py").touch()
    entrypoint = root.parent / "driver.py"
    entrypoint.write_text("import sys; sys.path.insert(0, '.')\n" + driver + "\n")
    rcfile = "/dev/null"
    if config is not None:
        rcfile = str(root.parent / "coverage.rc")
        Path(rcfile).write_text(config)
    argv = [sys.executable, "-m", "coverage", "run", f"--rcfile={rcfile}", "--source", str(root)]
    if branch:
        argv.append("--branch")
    environment = {**os.environ, "COVERAGE_FILE": str(root.parent / ".coverage")}
    subprocess.run([*argv, str(entrypoint)], cwd=root, env=environment, check=True, capture_output=True)
    output = root.parent / "native.json"
    subprocess.run([sys.executable, "-m", "coverage", "json", f"--rcfile={rcfile}", "-o", str(output)],
                   cwd=root, env=environment, check=True, capture_output=True)
    return json.loads(output.read_text())


class CoveragePyGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.base_directory.cleanup)
        cls.native = native_report(Path(cls.base_directory.name) / "src")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "src"
        self.root.mkdir()
        (self.root / "service.py").write_text(SOURCE)
        (self.root / "__init__.py").touch()
        self.report = copy.deepcopy(self.native)

    def run_check(self, value=...):
        with contextlib.redirect_stdout(io.StringIO()):
            return check(self.report if value is ... else value, self.root, "coveragepy")

    @property
    def entry(self):
        return self.report["files"]["service.py"]

    def test_real_native_full_decision_exits_are_exact(self):
        self.assertEqual(self.run_check(), {"lines": [4, 4], "branches": [2, 2]})
        self.entry["summary"]["percent_covered"] = 0
        self.entry["summary"]["percent_covered_display"] = "rounded or irrelevant"
        self.report["totals"] = {"percent_covered": 0}
        self.assertEqual(self.run_check()["lines"], [4, 4])

    def test_real_partial_native_branch_and_missing_line_fail(self):
        partial = native_report(self.root, "import service; service.choose(True)")
        with self.assertRaisesRegex(ValueError, "1 uncovered"):
            self.run_check(partial)
        self.assertEqual(counters(partial, self.root, "coveragepy"),
                         {"lines": [4, 3], "branches": [2, 1]})

    def test_real_unloaded_module_cannot_disappear(self):
        (self.root / "unloaded.py").write_text("def unused():\n    return 1\n")
        report = native_report(self.root)
        self.assertEqual(report["files"]["unloaded.py"]["missing_lines"], [1, 2])
        with self.assertRaisesRegex(ValueError, "2 uncovered"):
            self.run_check(report)
        del report["files"]["unloaded.py"]
        with self.assertRaisesRegex(ValueError, "Missing application Python.*unloaded.py"):
            self.run_check(report)

    def test_real_no_branch_collection_is_not_branch_coverage(self):
        report = native_report(self.root, branch=False)
        with self.assertRaisesRegex(ValueError, "branch-aware native"):
            self.run_check(report)

    def test_real_configured_line_and_partial_branch_exclusions_cannot_hide_failures(self):
        for pattern, expected in (("exclude_lines =\n    return 0", "Excluded Python"),
                                  ("partial_branches =\n    if ok:", "Inconsistent|summary disagrees")):
            report = native_report(self.root, "import service; service.choose(True)",
                                   config="[report]\n" + pattern + "\n")
            with self.subTest(pattern=pattern), self.assertRaisesRegex(ValueError, expected):
                self.run_check(report)

    def test_real_negative_exit_destinations_and_loop_branches(self):
        source = "def walk(items):\n    for item in items:\n        if item:\n            return item\n"
        (self.root / "loop.py").write_text(source)
        report = native_report(self.root, "import service, loop; service.choose(True); service.choose(False); "
                               "loop.walk([]); loop.walk([0]); loop.walk([1])")
        self.assertTrue(any(target < 0 for _, target in report["files"]["loop.py"]["executed_branches"]))
        self.assertEqual(self.run_check(report)["branches"], [6, 6])

    def test_real_traced_docstrings_are_not_invented_executable_lines(self):
        (self.root / "documented.py").write_text('"""Module documentation."""\nvalue = 1\n')
        report = native_report(self.root, "import service, documented; "
                               "service.choose(True); service.choose(False)")
        entry = report["files"]["documented.py"]
        self.assertEqual(entry["summary"]["num_statements"], 1)
        self.assertGreaterEqual(len(entry["executed_lines"]), 1)
        self.assertEqual(self.run_check(report)["lines"], [5, 5])

    def test_complete_source_inventory_retains_entrypoint_config_migrations_and_generated_code(self):
        for filename in ("manage.py", "config/settings.py", "apps/migrations/0001_initial.py", "proto/generated_pb2.py"):
            path = self.root / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("application_value = 1\n")
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, "Missing application Python"):
                self.run_check()
            path.unlink()
        for filename in ("tests/test_app.py", "test/test_app.py", "test_service.py", "service_test.py",
                         "tests.py", "conftest.py", ".venv/lib/dependency.py", "venv/dependency.py",
                         ".tox/py/lib/dependency.py", "node_modules/tool.py", "__pycache__/cache.py"):
            path = self.root / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("non_application_fixture = 1\n")
        (self.root / "README.md").write_text("Documentation\n")
        self.assertEqual(self.run_check()["lines"], [4, 4])

    def test_absolute_and_cwd_relative_native_paths_resolve_without_substitution(self):
        absolute = {str(self.root / name): entry for name, entry in self.report["files"].items()}
        self.assertEqual(self.run_check({**self.report, "files": absolute})["branches"], [2, 2])
        original = Path.cwd()
        os.chdir(self.root.parent)
        try:
            relative = {"src/" + name: entry for name, entry in self.report["files"].items()}
            self.assertEqual(self.run_check({**self.report, "files": relative})["branches"], [2, 2])
        finally:
            os.chdir(original)

    def test_foreign_dependency_measurements_cannot_mask_application_gaps(self):
        self.report["files"][str(self.root.parent / "dependency.py")] = {"untrusted": "ignored"}
        self.assertEqual(self.run_check()["lines"], [4, 4])
        del self.report["files"]["service.py"]
        with self.assertRaisesRegex(ValueError, "Missing application Python"):
            self.run_check()

    def test_unsafe_paths_duplicates_symlinks_and_nonproduction_entries_fail(self):
        for filename in ("", "../outside.py", "nested/../../outside.py"):
            value = copy.deepcopy(self.report)
            value["files"][filename] = self.entry
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, "Unsafe"):
                self.run_check(value)
        value = copy.deepcopy(self.report)
        value["files"][str(self.root / "service.py")] = self.entry
        with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
            self.run_check(value)
        for name in ("alias.py", "test_alias.py"):
            alias = self.root / name
            alias.symlink_to(self.root / "service.py")
            value = copy.deepcopy(self.report)
            value["files"][name] = self.entry
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Symbolic"):
                self.run_check(value)
            alias.unlink()
        path = self.root / "test_extra.py"
        path.write_text("not_application = 1\n")
        self.report["files"][str(path)] = self.entry
        with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
            self.run_check()

    def test_pragma_exclusions_are_rejected_but_literal_strings_are_not_directives(self):
        for directive in ("# pragma: no cover", "# PRAGMA: no branch", "# pragma : no   branch",
                          "# pragma no branch", "#pragmanocover"):
            (self.root / "service.py").write_text(SOURCE + directive + "\n")
            with self.subTest(directive=directive), self.assertRaisesRegex(ValueError, "ignore directives"):
                self.run_check()
        (self.root / "service.py").write_text(SOURCE + 'message = "# pragma: no cover"\n')
        self.assertEqual(self.run_check()["branches"], [2, 2])

    def test_invalid_source_empty_executable_inventory_and_excluded_lines_fail(self):
        (self.root / "service.py").write_text("def broken(:\n")
        with self.assertRaisesRegex(ValueError, "Invalid Python application source"):
            self.run_check()
        (self.root / "service.py").write_text(SOURCE)
        self.entry["executed_lines"] = []
        with self.assertRaisesRegex(ValueError, "empty executable"):
            self.run_check()
        self.report = copy.deepcopy(self.native)
        self.entry["excluded_lines"] = [3]
        with self.assertRaisesRegex(ValueError, "Excluded Python"):
            self.run_check()
        self.report = copy.deepcopy(self.native)
        self.entry["missing_lines"] = [3]
        with self.assertRaisesRegex(ValueError, "Inconsistent or empty"):
            self.run_check()

    def test_missing_empty_or_incompatible_metadata_cannot_claim_coverage(self):
        for value in (None, [], {}, {"meta": None}, {**self.report, "meta": {}}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "branch-aware native"):
                self.run_check(value)
        for key, value in (("format", 2), ("format", True), ("branch_coverage", 1),
                           ("branch_coverage", False), ("version", None), ("version", "")):
            report = copy.deepcopy(self.report)
            report["meta"][key] = value
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, "branch-aware native"):
                self.run_check(report)
        for value in (None, [], {}):
            with self.subTest(files=value), self.assertRaisesRegex(ValueError, "file measurements"):
                self.run_check({**self.report, "files": value})
        self.report["files"]["service.py"] = None
        with self.assertRaisesRegex(ValueError, "file measurements"):
            self.run_check()

    def test_invalid_and_duplicate_line_numbers_fail(self):
        for value in (None, {}, [True], [0], [-1], [1000], ["1"], [1, 1]):
            self.report = copy.deepcopy(self.native)
            self.entry["executed_lines"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "line numbers"):
                self.run_check()

    def test_invalid_duplicate_or_conflicting_decision_exits_fail(self):
        for value in (None, {}, [None], [[1]], [[True, 2]], [[0, 1]], [[1000, 1]],
                      [[2, 0]], [[2, 1000]], [[2, -1000]], [[2, 2]], [[2, 3], [2, 3]]):
            self.report = copy.deepcopy(self.native)
            self.entry["executed_branches"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "branch decision exit"):
                self.run_check()
        for taken, missing in (([[2, 3]], [[2, 3]]), ([[3, 2], [3, 4]], []),
                               ([], [[3, 2], [3, 4]]), ([[2, 3]], [])):
            self.report = copy.deepcopy(self.native)
            self.entry["executed_branches"] = taken
            self.entry["missing_branches"] = missing
            if taken and taken[0][0] == 3:
                self.entry["executed_lines"] = [1, 2, 4]
                self.entry["missing_lines"] = [3]
            elif missing and missing[0][0] == 3:
                self.entry["executed_lines"] = [1, 2, 4]
            with self.subTest(taken=taken, missing=missing), self.assertRaisesRegex(ValueError, "Inconsistent"):
                self.run_check()

    def test_missing_invalid_or_inconsistent_integer_summaries_fail(self):
        for value in (None, {}, {**self.entry["summary"], "covered_lines": True},
                      {**self.entry["summary"], "covered_lines": -1},
                      {**self.entry["summary"], "covered_lines": 5},
                      {**self.entry["summary"], "num_statements": 5},
                      {**self.entry["summary"], "num_statements": 0, "covered_lines": 0},
                      {**self.entry["summary"], "num_branches": 0},
                      {**self.entry["summary"], "num_partial_branches": 1}):
            self.report = copy.deepcopy(self.native)
            self.entry["summary"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "summary disagrees"):
                self.run_check()

    def test_empty_module_is_legitimate_but_empty_global_counts_never_pass(self):
        for source in ("", '"""Module documentation."""\n', "# Empty package\n"):
            (self.root / "__init__.py").write_text(source)
            self.assertEqual(self.run_check()["lines"], [4, 4])
        (self.root / "service.py").unlink()
        self.report["files"].pop("service.py")
        with self.assertRaisesRegex(ValueError, "No lines measured.*No branches measured"):
            self.run_check()
        (self.root / "__init__.py").unlink()
        with self.assertRaisesRegex(ValueError, "No application Python"):
            self.run_check()

    def test_strict_json_loader_and_actual_cli_reject_duplicate_keys(self):
        filename = self.root.parent / "report.json"
        filename.write_text(json.dumps(self.report))
        self.assertEqual(load_report(filename), self.report)
        for text in ('{"files": {}, "files": {}}', '{"meta": {"format": 3, "format": 3}}'):
            filename.write_text(text)
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "Duplicate coverage JSON"):
                load_report(filename)
        script = str(Path(__file__).with_name("check_coverage.py"))
        with patch.object(sys, "argv", [script, str(filename), str(self.root), "coveragepy"]), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            runpy.run_path(script, run_name="__main__")
        self.assertEqual(error.exception.code, 1)
        filename.write_text(json.dumps(self.report))
        with patch.object(sys, "argv", [script, str(filename), str(self.root), "coveragepy"]), \
                contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    unittest.main()
