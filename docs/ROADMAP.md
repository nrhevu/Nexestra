# Workspace and harness roadmap

Prioritize complete, verified user workflows. Planned behavior is not yet available. Update this
file at tested checkpoints; session continuity is in [`PROGRESS.md`](../PROGRESS.md).

| Slice | Acceptance behavior | Status | Verification |
| --- | --- | --- | --- |
| Existing local workspace | Scoped chat, agents, knowledge, artifacts and repository assignments | Implemented, documented limits apply | `pnpm check` |
| Shared Work Briefs | Human and Master share durable scope/checks; stale writes fail; restart restores context; no repository required | Implemented and verified | `pnpm test -- src/server/work-brief.test.ts src/server/runtime.test.ts src/web/surfaces/WorkBriefs.test.tsx src/web/App.test.tsx` |
| General work units and acceptance | Research/document/design/code declare outputs and checks; a Worker reply cannot self-certify success | Implemented: typed tasks, frozen contracts, human acceptance | Offline API/dispatcher, restart and failure scenarios |
| General execution environments | Non-code tasks use isolated directories, code retains worktrees, outputs are inspectable | Implemented, including verified prior inputs for document/design revisions; retention/cleanup remains planned | Both target kinds, bounded capture, revision provenance, cancellation and restart |
| Evidence and review | Checks identify artifact/contract revision and reviewer; stale checks cannot pass changed work | Human observations and hashed non-Git output snapshots implemented; executable verifiers planned | Reject direct completion and missing/stale evidence; inspect actual outputs |
| Declarative surfaces | User or harness creates a useful view from a bounded schema; UI/tool parity | Implemented: table/board/canvas/document, import/export, revisions, scoped Master tools | Browser flow, conflicts, invalid manifests, safe rendering |
| Durable goals and loops | Authorized goals retain budget/stop policy across restart without replaying ambiguous effects | Implemented: WIP=1, pinned scope/brief, human review gates, attempts/deadline, explicit restart resumption | Crash/restart, ambiguity, cancellation, paused review and exhaustion |
| Scoped context and checkpoints | Fresh sessions resume the right unit with relevant decisions and evidence | Implemented: bounded recent transcript, read_history search/pagination, pinned briefs/contracts, task/goal state, surface selections; semantic indexing and exact replay remain planned | Canonical bytes unchanged, Unicode chunks, thread scope, HTTP/tool parity and pre-request size guard |
| Optional graphs | Typed nodes, joins and repairs coordinate independent work under one budget | Planned after loop acceptance | Dependencies, failures, conflicts and local repair |
| Isolated renderer SDK | Novel plugin interactions run outside the trusted origin with bounded rights | Planned after declarative views | Capabilities, lifecycle and browser isolation |

These are dependency-ordered slices, not promises that all fit one milestone. Do not expand agent
fan-out before acceptance and user review capacity are reliable.
