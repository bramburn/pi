# Decision matrix v1

This directory is the **Phase 1** sign-off artefact for the
"DeepSeek Harness for pi" feature, per the user's documented
4-phase xlsx + markdown workflow (Phase 0 = PRD md, Phase 1 =
Decision matrix v1, Phase 2 = review for follow-ups, Phase 3 =
Decision matrix v2 tie-back, Phase 4 = Spec sheets).

## Files

- `decision_matrix_data.py` — the 15-row data dict and
  `EXPECTED_ROW_COUNT` constant. The single source of truth.
- `build_decision_matrix.py` — the openpyxl builder. Imports
  the data dict, asserts every required key per row, writes the
  xlsx.
- `test_build_decision_matrix.py` — unit tests covering the
  assert rules and the workbook shape.
- `decision-matrix-v1.xlsx` — the produced xlsx. **Gitignored.**
- `decision-matrix-v1.xlsx.bak` — the previous xlsx, if a
  re-run renamed it. Holds the user's last hand-edit; recover
  by diffing against the new build.

## How to re-build

From this directory:

```
python build_decision_matrix.py
```

The build is deterministic — same data dict + same script =
byte-identical xlsx. The build renames any existing
`decision-matrix-v1.xlsx` to `.bak` before writing, so a
hand-edit in Excel is recoverable.

`python build_decision_matrix.py --check` runs the asserts
only and writes no file. Use this after editing the data
dict to confirm the schema is still valid.

## How to mark decisions

1. Open `decision-matrix-v1.xlsx` in Excel.
2. On the **Decision Matrix** sheet, fill in:
   - `user decision` column: Ship / Defer / Reject
   - `user notes` column: free text, especially for items
     you Defer or Reject
3. Save and close the file.
4. Do **not** re-run the build after filling in your
   decisions — that would overwrite your hand-edit. (The
   build moves the existing file to `.bak`; the `.bak`
   holds your decisions if you accidentally re-run.)

## Schema rules

The build asserts the following per row (the "dicts + assert
k in d" rule):

- Required keys: `id`, `question`, `phase`, `severity`,
  `effort`, `depends_on`, `affected_files`,
  `my_recommendation`, `recommendation_rationale`.
- `phase` ∈ {`Toggle surface`, `Phase 1`, `Phase 2`,
  `Phase 3`, `Phase 4`, `Deferred`}.
- `severity` ∈ {`High`, `Medium`, `Low`}.
- `effort` ∈ {`S`, `M`, `L`, `XL`}.
- `my_recommendation` ∈ {`Ship`, `Defer`, `Reject`}.
- `depends_on` is a list[int] of ids that exist in the same
  data dict.
- ids are `1..EXPECTED_ROW_COUNT` in order, no gaps, no
  duplicates.

## What does NOT happen

- No code is written until the xlsx is closed out.
- The xlsx is gitignored; the data, build script, test file,
  and this README are tracked.
- No CI hook runs the build — the user runs it locally.

## Next step

When every row has a `user decision`, the next artefact is
`decision-matrix-v2.xlsx`, which ties back to v1 with the
user's decisions recorded and any follow-up questions. The
follow-up plan for v2 is triggered when v1 is closed out.
