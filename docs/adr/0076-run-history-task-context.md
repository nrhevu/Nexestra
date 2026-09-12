# 0076 — Show delegated task context in run history

## Status

Accepted

## Decision

Run history rows include an optional redacted Taskboard title when the run ID matches a persisted
Worker assignment in the selected workspace. Runs without that assignment mapping remain unchanged.
The title is display context only; task status and assignment lifecycle remain authoritative in
Taskboard.

## Consequences

Monitoring can distinguish delegated work without opening each conversation, which helps compare
heterogeneous Workers against the planned task. Legacy or ordinary chat runs do not gain fabricated
task metadata, and no transcript content or credentials are added to history responses.
