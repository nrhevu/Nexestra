# 0009 — Drive Codex with `codex exec --json`

## Context

Codex offers two machine interfaces: `codex exec --json`, which prints JSONL to
stdout and exits, and `codex app-server`, a long-lived JSON-RPC service that can
be steered mid-run.

## Decision

Use `codex exec --json` for v1: one process per run, JSONL parsed into
`HarnessEvent`s, cancellation by killing the process group. Keep
`codex app-server` for when mid-run steering is actually needed.

## Consequences

- Everything the loop needs today — `-C`, `-m`, `-s`, `--output-schema`,
  `--ephemeral`, `-o last-message`, `-c model_reasoning_effort=…` — is a flag,
  and the run's lifetime is the process's lifetime.
- The protocol is pinned by recordings, not by documentation: every file in
  `fixtures/codex/` was captured from codex-cli 0.148.0 and carries a
  `*.meta.json` naming the version, so a protocol change fails a test.
- The cost is that `pause()` cannot suspend a live run — it stops dispatching
  and lets in-flight runs finish (`docs/orchestrator.md` §9). Fixing that means
  adopting `app-server`.
- Practical detail worth keeping: stdin is redirected from `/dev/null`, and a
  non-empty stderr is **not** a failure — Codex writes an informational line
  there on every piped run.

## Status

Accepted. Implemented in `packages/adapters/codex/src/command.ts`,
`packages/adapters/codex/src/process.ts`,
`packages/adapters/codex/src/parser.ts`,
`packages/adapters/codex/src/jsonl.ts`. PLAN.md §1.8;
`docs/harness-protocols.md` §1; `docs/adapters/codex.md`.
