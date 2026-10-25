import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from check_coverage import check
from coverage_plan import check_plan
from istanbul_coverage import counter_sites


FIXTURE = json.loads((Path(__file__).parent.parent / "test/fixtures/istanbul-statement-free.json").read_text())
ERASURE = json.loads((Path(__file__).parent.parent / "test/fixtures/istanbul-erased-typescript.json").read_text())


class StatementFreeNativeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "application"
        self.root.mkdir()
        (self.root / "active.js").write_text(FIXTURE["active_source"])

    def verify(self, item):
        (self.root / item["filename"]).write_text(item["source"])
        report = {**FIXTURE["active_report"], **item["report"]}
        (self.root / "coverage.json").write_text(json.dumps(report))
        with contextlib.chdir(self.root.parent), contextlib.redirect_stdout(io.StringIO()):
            direct = check(report, self.root, "istanbul")
            planned = check_plan([{"format": "istanbul", "report": "application/coverage.json",
                                   "source_directory": "application"}], self.root.parent)
        return direct, planned

    def test_real_native_statement_free_sources_pass_both_entry_points(self):
        # Keep report keys exactly as emitted by the real instrumenter. Resolve
        # these relative paths from the same directory as the fictional sources.
        for item in FIXTURE["cases"]:
            with self.subTest(filename=item["filename"]):
                direct, planned = self.verify(item)
                self.assertEqual(direct, {"lines": [2, 2], "branches": [2, 2]})
                self.assertEqual(planned["totals"], direct)
                (self.root / item["filename"]).unlink()

    def test_real_branch_only_source_needs_its_native_branches(self):
        direct, planned = self.verify(FIXTURE["branch_only"])
        self.assertEqual(direct, {"lines": [2, 2], "branches": [3, 3]})
        self.assertEqual(planned["totals"], direct)
        forged = copy.deepcopy(FIXTURE["branch_only"])
        entry = forged["report"]["application/" + forged["filename"]]
        entry["branchMap"], entry["b"] = {}, {}
        with self.assertRaisesRegex(ValueError, "No branches measured.*default-param.js"):
            self.verify(forged)

    def test_compiler_erased_ambient_trees_retain_their_real_empty_measurements(self):
        for item in ERASURE["ambient"]:
            with self.subTest(filename=item["filename"]):
                direct, planned = self.verify(item)
                self.assertEqual(direct, {"lines": [2, 2], "branches": [2, 2]})
                self.assertEqual(planned["totals"], direct)
                (self.root / item["filename"]).unlink()

    def test_live_siblings_and_runtime_namespace_class_or_overload_cannot_borrow_erasure(self):
        for item in ERASURE["runtime"]:
            with self.subTest(filename=item["filename"]):
                with self.assertRaisesRegex(ValueError, "uncovered"):
                    self.verify(item)
                with contextlib.chdir(self.root.parent), self.assertRaisesRegex(ValueError, "uncovered"):
                    check_plan([{"format": "istanbul", "report": "application/coverage.json",
                                 "source_directory": "application"}], self.root.parent)
                forged = copy.deepcopy(item)
                entry = forged["report"]["application/" + forged["filename"]]
                entry["statementMap"], entry["s"], entry["branchMap"], entry["b"] = {}, {}, {}, {}
                with self.assertRaisesRegex(ValueError, "No statements measured"):
                    self.verify(forged)
                with contextlib.chdir(self.root.parent), self.assertRaisesRegex(ValueError, "No statements measured"):
                    check_plan([{"format": "istanbul", "report": "application/coverage.json",
                                 "source_directory": "application"}], self.root.parent)
                (self.root / item["filename"]).unlink()

    def test_an_entirely_erased_component_still_needs_nonempty_native_measurements(self):
        (self.root / "active.js").unlink()
        item = ERASURE["ambient"][0]
        (self.root / item["filename"]).write_text(item["source"])
        (self.root / "coverage.json").write_text(json.dumps(item["report"]))
        with contextlib.chdir(self.root.parent), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "No lines measured"):
                check(item["report"], self.root, "istanbul")
            with self.assertRaisesRegex(ValueError, "Every coverage part requires nonempty"):
                check_plan([{"format": "istanbul", "report": "application/coverage.json",
                             "source_directory": "application"}], self.root.parent)

    def test_a_statement_free_file_must_still_be_present_in_the_report(self):
        (self.root / "comments.js").write_text("// deliberately empty\n")
        with contextlib.chdir(self.root.parent), self.assertRaisesRegex(ValueError, "Missing application source.*comments.js"):
            check(FIXTURE["active_report"], self.root, "istanbul")

    def test_parser_and_transport_errors_stop_validation(self):
        file = self.root / "invalid.js"
        file.write_text("const = ;")
        with self.assertRaisesRegex(ValueError, "Cannot inspect statement-free"):
            counter_sites(file)
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("node", 10)):
            with patch("istanbul_coverage.subprocess.run", side_effect=error), self.assertRaisesRegex(
                    ValueError, "Cannot inspect statement-free"):
                counter_sites(file)
        for output in ('null', '{"statements": true}', '{"statements": true, "branches": 1}', 'not JSON'):
            with patch("istanbul_coverage.subprocess.run", return_value=subprocess.CompletedProcess(
                    [], 0, output, "")), self.assertRaisesRegex(ValueError, "Cannot inspect statement-free"):
                counter_sites(file)


if __name__ == "__main__":
    unittest.main()
