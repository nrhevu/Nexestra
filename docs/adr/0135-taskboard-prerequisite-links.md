# ADR 0135: Link Taskboard prerequisites

- Status: Accepted
- Date: 2026-09-13

## Context

Dependency-blocked Taskboard cards previously showed only a count, so recovering a plan required
searching the board for each prerequisite. The selected workspace already contains the task
projection needed to make those edges actionable without another API call.

## Decision

Taskboard renders at most three prerequisite controls per card, each with the prerequisite title and
status. A control opens the existing process inspection dialog for that task. Missing IDs and IDs
outside the selected workspace render a bounded unavailable label; additional prerequisites are
represented by a count. No task mutation or dispatch occurs from these controls.

## Consequences

Plan recovery is faster and preserves the existing inspection flow. The display remains bounded and
workspace-scoped, and legacy or partially imported plans cannot crash the board. Full prerequisite
search and dependency editing remain separate concerns.
