# ADR 0139: Rate completed Worker results from the Taskboard process view

- Status: Accepted
- Date: 2026-09-14

## Context

Nexestra already records durable helpful/needs-work feedback for canonical agent replies, but a
Worker delivery is normally reviewed from the Taskboard process view. Requiring the user to find the
same reply in its source thread disconnects task delivery from the quality, cost, and review signals
used to reduce repeated low-quality output.

## Decision

When a completed task has a canonical Worker reply, the process response includes that reply's
existing feedback. The result panel exposes helpful and needs-work controls that call the existing
message-feedback route with the canonical message ID. Rating changes remain feedback on the reply,
not a new task status or a mutation of Worker output.

## Consequences

Task delivery review feeds the existing run-cost and Needs-work views without duplicating feedback
state. Clearing or changing a rating behaves exactly as it does in conversation. Legacy assignments
without a canonical reply have no rating control, and a negative result rating does not automatically
retry, block, or reassign the task.
