# Workspace and harness roadmap

Prioritize complete, verified user workflows. Planned behavior is not yet available. Update this
file at tested checkpoints; session continuity is in [`PROGRESS.md`](../PROGRESS.md).

| Slice | Acceptance behavior | Status | Verification |
| --- | --- | --- | --- |
| Existing local workspace | Scoped chat, agents, knowledge, artifacts and repository assignments | Implemented, documented limits apply | `pnpm check` |
| Shared Work Briefs | Human and Master share durable scope/checks; stale writes fail; restart restores context; no repository required | Implemented and verified | `pnpm test -- src/server/work-brief.test.ts src/server/runtime.test.ts src/web/surfaces/WorkBriefs.test.tsx src/web/App.test.tsx` |
| General work units and acceptance | Research/document/design/code declare outputs and checks; a Worker reply cannot self-certify success | Implemented: typed tasks, frozen contracts, human acceptance | Offline API/dispatcher, restart and failure scenarios |
| General execution environments | Non-code tasks use isolated directories, code retains worktrees, outputs are inspectable | Planned | Both target kinds, containment and cleanup checks |
| Evidence and review | Checks identify artifact/contract revision and reviewer; stale checks cannot pass changed work | Implemented for human observations; output snapshots and executable verifiers remain planned | Reject direct completion and missing/stale evidence; inspect actual outputs |
| Declarative surfaces | User or harness creates a useful view from a bounded schema; UI/tool parity | Planned | Browser flow, conflicts, invalid manifests, safe rendering |
| Durable goals and loops | Authorized goals retain budget/stop policy across restart without duplicating effects | Planned | Crash/restart, ambiguity, cancellation and exhaustion |
| Scoped context and checkpoints | Fresh sessions resume the right unit with relevant decisions and evidence | Planned | Context budget, relevance, replay and smoke checks |
| Optional graphs | Typed nodes, joins and repairs coordinate independent work under one budget | Planned after loop acceptance | Dependencies, failures, conflicts and local repair |
| Isolated renderer SDK | Novel plugin interactions run outside the trusted origin with bounded rights | Planned after declarative views | Capabilities, lifecycle and browser isolation |

These are dependency-ordered slices, not promises that all fit one milestone. Do not expand agent
fan-out before acceptance and user review capacity are reliable.
