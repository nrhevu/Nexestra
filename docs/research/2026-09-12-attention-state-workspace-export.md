# Attention state in workspace exports — 2026-09-12

Portable workspace exports previously carried tasks, assignments, transcripts, and feedback but not
the user's derived attention snooze or dismissal state. Adding the already bounded metadata to the
selected workspace's `state.json` keeps monitoring triage with the rest of the workspace snapshot.

The export remains workspace-scoped and does not become a backup or import mechanism. Foreign
attention entries are filtered before archive generation, and the existing redaction and snapshot
barrier continue to apply.
