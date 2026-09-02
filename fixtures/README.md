# fixtures/

Recorded harness output used by the adapter contract tests (PLAN.md §5, §9).

Empty until M4: `codex exec --json` JSONL goes under `codex/`, `opencode serve`
SSE streams under `opencode/`. Each recording is committed together with the
harness version it came from, so a parser regression shows up as a failing test
rather than a crash at runtime.
