# 0001 — Local-first: a Node server on the user's machine plus a browser SPA

## Context

Nexestra drives coding harnesses (Codex, OpenCode) and git worktrees. Both need
to run on the machine that holds the source code, with the user's own CLI
logins. A hosted service would have to ship the repository somewhere else and
re-authenticate every harness on the user's behalf.

## Decision

Ship one Node process that the user starts themselves, and a React SPA that
talks to it over `/api` and `/ws`. No cloud component, no account.

## Consequences

- Harness processes, git and the SQLite file are all on the same machine, so
  paths in the database are absolute local paths and mean what they say.
- Packaging (Electron/Tauri) stays an option later; nothing in the codebase
  assumes a browser origin other than the server's own.
- Anything the server can do, the user could already do in a terminal — which is
  why the approval gates ([0017](0017-approval-gates-and-budget-rules.md)) are
  about intent, not about privilege.

## Status

Accepted. Implemented in `apps/server/src/index.ts`, `apps/server/src/app.ts`,
`apps/web/src/main.tsx`. PLAN.md §1.1.
