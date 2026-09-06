# Upstream-Closed-Issue Sync

Periodically scans `earendil-works/pi` for **user-contributed** issues that
were closed upstream (auto-close gate or `no-action` triage) but look like
real bugs / refactors / perf fixes, and creates a corresponding ticket in
the fork `bramburn/pi` so the fork can implement them independently.

The script intentionally does **not** copy new features, "add X as a
provider" proposals, or any upstream PR that was already merged.

## Run

```bash
# One-off dry run (no issues created)
npm run sync:upstream:dry

# One-off live run (creates up to --max-new issues, default 30)
npm run sync:upstream -- --max-new 30

# Schedule weekly Monday 09:00 local time
npm run sync:upstream:install-schedule
npm run sync:upstream:status
npm run sync:upstream:uninstall-schedule
```

The schedule uses Windows Task Scheduler (`\Pi\UpstreamSync`) on Windows
and the user crontab on macOS / Linux.

## What gets copied

For each candidate the fork issue body starts with a provenance block:

```
> Synced from upstream **earendil-works/pi#N** (closed, not implemented there).
> - Source: https://github.com/earendil-works/pi/issues/N
> - Upstream author: @<login>
> - Upstream opened: <ts>
> - Upstream closed: <ts>
> - Upstream labels: <list>

## Original report
<upstream body verbatim>

## Fork notes
- [ ] Reproduce / confirm against fork `main`
- [ ] Decide on scope: minimal patch vs. broader refactor
- [ ] Implement
- [ ] Add regression test under `packages/coding-agent/test/suite/regressions/`
```

Labels mapped from upstream → fork:

| Upstream           | Fork                                                  |
| ------------------ | ----------------------------------------------------- |
| `bug`              | `bug`, `priority:medium` (if crash/perf in title)    |
| `untriaged`        | `untriaged`                                           |
| `help wanted`      | `help wanted`                                         |
| `pkg:agent` etc.   | `pkg:agent` etc. (only the four we ship)              |
| `pkg:mom/pods/...` | _dropped — fork doesn't publish those packages_       |

## What gets skipped

| Skip reason        | Trigger                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Bot / dependabot   | `* [bot]` author or `is_bot=true`                                        |
| Weekend auto-close | Only labels are `close-because-weekend` etc.                             |
| Other-org packages | Only labels are `pkg:mom`, `pkg:pods`, `pkg:proxy`, `pkg:web-ui`         |
| Pure new feature   | Title matches `add X as a provider` / `proposal: add ...` etc.           |
| Not an improvement | No `bug` / `help wanted` label and body fails all improvement patterns   |
| Already synced     | Upstream issue number is in `scripts/.upstream-sync-state.json`          |
| Duplicate          | A fork issue matches the title (normalized) or cites the upstream number |

The improvement patterns live at the top of `sync-upstream-closed-issues.mjs`
in `IMPROVEMENT_PATTERNS`. Edit them if the fork wants a tighter / looser
filter.

## State

`scripts/.upstream-sync-state.json` (gitignored) records:

- `lastRunAt` — window start for the next run
- `syncedUpstreamNumbers` — the last 5000 upstream issue numbers we've seen,
  regardless of whether we created a fork ticket for them (this is what
  makes the sync safely idempotent)

To force a re-scan of the whole 6-month window, delete that file and run
again.

## First run vs. subsequent runs

- **First run** (~5 min, ~95 GraphQL pages): scans all ~4.7k closed issues
  in the 6-month window, dedupes against the fork, and creates up to
  `--max-new` issues.
- **Subsequent runs** (~30s): scans only issues closed since the previous
  run; creates 0 most weeks, occasionally a handful.

The `--since-months N` flag changes the initial-scan window length.