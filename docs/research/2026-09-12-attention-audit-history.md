# Attention audit history research

The harness brief emphasizes monitoring, isolation, and transfer of useful outcomes. Current
Attention state is derived from active runs and task assignments, while snooze and dismiss metadata
only controls visibility. A small action history makes supervision explainable without persisting
the content that caused the alert.

The chosen record is deliberately narrow: workspace ID, attention ID, one of the known attention
kinds, action, timestamp, and snooze expiry. It is stored in the existing state file with a 200-entry
retention cap per workspace and exposed through a workspace-scoped endpoint. The UI loads it only on
an explicit refresh, keeping normal bootstrap and activity polling unchanged.

Per-workspace retention preserves isolation when multiple workspaces are active. Unknown kinds are
used for older callers that do not send the optional kind field. The audit is durable supervision
metadata, not a transcript, notification queue, or event-sourcing replacement; titles, details,
prompts, raw errors, provider configuration, and credentials remain excluded.
