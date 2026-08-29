"""
Unit tests for the decision-matrix build script.

Run from the decisions/ directory:
    python -m unittest test_build_decision_matrix.py

Or via pytest if available:
    pytest test_build_decision_matrix.py

The tests verify the "dicts + assert k in d" rule: every required
key is present, every value is in its allow-list, ids are 1..N in
order, and depends_on references resolve.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Make the build script and data module importable when this file
# is run from research/decisions/ or from anywhere on sys.path.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import build_decision_matrix as builder
import decision_matrix_data as data


def _row(**overrides) -> dict:
    """Return a copy of row 1 with optional overrides applied.

    Used to construct malformed fixtures for the negative tests.
    """
    base = {k: v for k, v in data.DECISION_MATRIX_ROWS[0].items()}
    base.update(overrides)
    return base


class RequiredKeysTests(unittest.TestCase):
    def test_data_passes_baseline(self) -> None:
        """The shipped data dict must pass assert_data() unchanged."""
        builder.assert_data()

    def test_missing_required_key_fails(self) -> None:
        bad = _row()
        del bad["question"]
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = bad
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("question", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_extra_key_fails(self) -> None:
        bad = _row(unexpected_extra="surprise")
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = bad
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("unexpected_extra", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_row_count_mismatch_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[:] = original[:-1]
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("rows", str(ctx.exception).lower())
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_duplicate_id_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        # Two rows with the same id.
        data.DECISION_MATRIX_ROWS[1] = {
            **original[1],
            "id": original[0]["id"],
        }
        try:
            with self.assertRaises(AssertionError):
                builder.assert_data()
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_id_out_of_range_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "id": 0}
        try:
            with self.assertRaises(AssertionError):
                builder.assert_data()
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_invalid_severity_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "severity": "Critical"}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("severity", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_invalid_effort_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "effort": "1d"}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("effort", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_invalid_decision_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "my_recommendation": "Maybe"}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("recommendation", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_invalid_phase_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "phase": "Phase 5"}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("phase", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_dangling_depends_on_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "depends_on": [999]}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("999", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original

    def test_non_list_depends_on_fails(self) -> None:
        original = data.DECISION_MATRIX_ROWS[:]
        data.DECISION_MATRIX_ROWS[0] = {**original[0], "depends_on": "1, 2"}
        try:
            with self.assertRaises(AssertionError) as ctx:
                builder.assert_data()
            self.assertIn("depends_on", str(ctx.exception))
        finally:
            data.DECISION_MATRIX_ROWS[:] = original


class WorkbookTests(unittest.TestCase):
    def test_workbook_has_two_sheets(self) -> None:
        wb = builder.build_workbook()
        names = wb.sheetnames
        self.assertEqual(names, ["Overview", "Decision Matrix"])

    def test_decision_matrix_has_expected_row_count(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Decision Matrix"]
        # 1 header row + N body rows.
        self.assertEqual(ws.max_row, data.EXPECTED_ROW_COUNT + 1)
        self.assertEqual(ws.max_column, len(builder.COLUMNS))

    def test_decision_matrix_frozen_panes(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Decision Matrix"]
        self.assertEqual(ws.freeze_panes, "A2")

    def test_overview_title(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Overview"]
        self.assertEqual(ws["A1"].value, builder.OVERVIEW_TITLE)

    def test_decision_matrix_header_values(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Decision Matrix"]
        header = [ws.cell(row=1, column=c).value for c in range(1, len(builder.COLUMNS) + 1)]
        expected = [name.replace("_", " ") for name, _w, _k in builder.COLUMNS]
        self.assertEqual(header, expected)

    def test_decision_matrix_user_columns_blank(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Decision Matrix"]
        # The last two columns are user_decision and user_notes; they
        # should be empty for every data row in the build output. The
        # build script writes "" (not None) for missing keys, since
        # openpyxl serialises that to a truly-blank cell.
        user_decision_col = [c for c, (n, _w, _k) in enumerate(builder.COLUMNS, start=1) if n == "user_decision"][0]
        user_notes_col = [c for c, (n, _w, _k) in enumerate(builder.COLUMNS, start=1) if n == "user_notes"][0]
        for row_idx in range(2, data.EXPECTED_ROW_COUNT + 2):
            for col_idx in (user_decision_col, user_notes_col):
                cell_value = ws.cell(row=row_idx, column=col_idx).value
                self.assertIn(cell_value, (None, ""), f"row {row_idx} col {col_idx} should be blank, got {cell_value!r}")

    def test_decision_matrix_id_column(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Decision Matrix"]
        id_col = 1  # id is the first column
        for row_idx, expected_id in enumerate(range(1, data.EXPECTED_ROW_COUNT + 1), start=2):
            self.assertEqual(ws.cell(row=row_idx, column=id_col).value, expected_id)

    def test_overview_summary_counts(self) -> None:
        wb = builder.build_workbook()
        ws = wb["Overview"]
        by_decision = {d: 0 for d in builder.ALLOWED_DECISION}
        for row in data.DECISION_MATRIX_ROWS:
            by_decision[row["my_recommendation"]] += 1
        # Cells A16, A17, A18 hold Ship / Defer / Reject counts.
        self.assertIn(str(by_decision["Ship"]), ws["A16"].value)
        self.assertIn(str(by_decision["Defer"]), ws["A17"].value)
        self.assertIn(str(by_decision["Reject"]), ws["A18"].value)
        self.assertIn(str(sum(by_decision.values())), ws["A19"].value)


class CheckFlagTests(unittest.TestCase):
    def test_check_flag_exits_zero(self) -> None:
        """`--check` runs the asserts but writes no file."""
        rc = builder.main(["--check"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
