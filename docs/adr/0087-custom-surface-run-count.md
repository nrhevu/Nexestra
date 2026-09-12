# ADR 0087 — Live run counts on custom surfaces

## Status

Accepted.

## Decision

Declarative custom-surface cards targeting Run history receive the selected workspace's active-run
count. The count is derived from bootstrap/activity metadata and remains display-only; configured
cards cannot execute code or query other workspaces.
