# Server-authoritative restore preflight research — 2026-09-13

Browser ZIP inspection already verifies integrity and target-aware conflict categories, but a
mutation path needs an authority independent of client-provided results. The new POST preflight
reuses the shared ZIP verifier on the server, checks target workspace identity, refreshes the local
recovery manifest, and returns the same bounded path categories.

The recovery manifest now hashes the same redacted pretty-printed metadata bytes emitted by export.
That prevents unchanged `state.json` from being reported as a false conflict when the source archive
omits known credentials. Invalid or cross-workspace archives fail before any write. Actual import,
merge, overwrite, and rollback remain separate decisions.
