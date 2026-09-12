# Reversible workspace archive research

The recovery manifest made a destructive delete plan auditable, but a physical move still needs
transaction and crash-recovery rules for every workspace-owned path. A soft archive supplies the
useful user-facing lifecycle step now: exact-name confirmation, active-work guards, and an atomic
`archived` flag hide the workspace while leaving transcripts, artifacts, Knowledge repositories,
worktrees, and credentials untouched.

Active bootstrap and activity APIs filter archived workspaces. Settings receives the bounded archived
list and can restore an entry with one atomic state write. This keeps archive/restore reversible and
preserves workspace IDs, while explicitly deferring trash moves, permanent purge, and journaling.
