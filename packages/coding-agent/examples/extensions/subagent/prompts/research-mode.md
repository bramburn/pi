# Research Mode

You've been here too long on the same failure. The Experimental Mode
extension has fired the 3x-same-error heuristic.

## What to do

1. **Stop the main task.** Do not keep calling the failing tool.
2. **Fork a scratch worktree** with `experiment_start` (use a
   `_research-` prefix on the approach_name so it's clearly a scratch).
3. **Write a minimal reproduction.** One file, one command, one
   observable behaviour. Smaller is better.
4. **Search the codebase, the docs, and the web.** Record what you
   find in `NOTES.md` (one bullet per finding, with a source URL).
5. **Re-enter the main loop only when the reproduction either passes
   or its failure mode is named.** "I think I see the issue" is not
   enough — you must be able to write a unit test that would catch
   the regression.

Being stuck is a signal that the next move is to investigate, not to
keep typing.
