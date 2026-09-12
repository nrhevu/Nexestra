# Workspace deletion preflight research

Workspace deletion crosses durable state, one JSONL transcript per thread, artifact directories,
Knowledge storage, task assignments, attention metadata, and write-only agent credentials. A safe
first step is a read-only preflight that makes those dependencies visible and blocks the obvious
hazards.

The endpoint counts only the selected workspace, reports active dispatcher runs and queued/running
assignments, and counts agents that have a stored credential without returning the credential or agent
identity. It rejects the last-workspace case through `canDelete: false` and supplies the exact name
that a future destructive dialog must require. Filesystem artifact counting is bounded and traverses
only storage IDs from workspace-owned threads. No state or files are changed; deletion must later
revalidate all counts and provide tombstone/rollback behavior.
