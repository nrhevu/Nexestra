# 0075 — Capture completed Worker results from Taskboard

## Status

Accepted

## Decision

Expose the canonical Worker reply for the latest Taskboard assignment in the task process
response. When a Worker has completed and produced a reply, Taskboard offers the existing reviewed
Knowledge capture dialog directly from the result. The server still captures by the immutable
thread and message IDs, redacts known credentials, and records message provenance; the UI does not
trust the displayed assignment result as a second source of content.

## Consequences

Completed delegated work can move into durable Knowledge without making the user reopen a thread or
copy text manually. Legacy assignments or transcripts without a matching Worker message simply do
not show the action. No automatic promotion occurs, and failed or interrupted results cannot be
captured through this shortcut.
