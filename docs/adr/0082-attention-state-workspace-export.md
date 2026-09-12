# ADR 0082 — Preserve attention state in workspace exports

## Status

Accepted.

## Decision

Workspace ZIP exports include the selected workspace's bounded attention snooze and dismissal
metadata in `state.json`. Foreign workspace entries remain excluded. Exporting this metadata does not
claim that an archive is a complete backup or add an import workflow.

## Consequences

Review triage survives export for future inspection or restore tooling. The existing snapshot,
redaction, and workspace isolation rules remain unchanged.
