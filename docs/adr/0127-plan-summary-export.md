# ADR 0127: Plan summary export

- Status: Accepted
- Date: 2026-09-13

## Context

Taskboard now gives users a bounded read-only view of Master-created plans, but a debate or research
handoff still requires copying the screen manually. The workspace export is intentionally broader
and contains transcripts, so it is not an appropriate handoff packet.

## Decision

Taskboard offers a client-only **Export plan summaries** action. It serializes a versioned
`nexestra.plan-summary` JSON packet from the selected workspace's already-loaded plan summaries.
The packet includes plan and task IDs, titles, task status, bounded progress counts, worker assignee
labels (`id`, name, handle, harness, model), and latest assignment status.

The packet is capped at 200 plans and 200 task entries. It excludes task descriptions and
verification commands, transcripts, prompts, credentials, repository IDs, branch names, and
worktree paths. If the loaded data exceeds a cap, the packet keeps the full per-plan counts and
sets `truncated: true`. No server call or state mutation is made.

## Consequences

Users can move a compact plan snapshot into a review or research workflow without exposing the
workspace's sensitive execution context. The export reflects the loaded selected-workspace snapshot;
refreshing remains the way to obtain newer state.
