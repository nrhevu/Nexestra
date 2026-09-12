# Review queue agent and thread filters research — 2026-09-12

The review queue is useful for a focused quality pass, but a workspace with several agents or active
threads quickly produces a noisy list. The API already validates optional `agentId` and `threadId`
against the requested workspace and includes both fields in its opaque cursor payload, so the missing
piece was an intentional UI affordance.

The selected design uses the current workspace bootstrap's redacted agent and thread labels. This
avoids another discovery endpoint and keeps archived conversations available for historical review.
Selecting a value sends its stable ID, clears the loaded page, and starts a new race-guarded request;
the server rejects cursors created for another filter combination. Exported review cases record the
selection so an offline evaluator can reproduce which slice was loaded.

This remains a triage filter rather than a saved view or cross-workspace query. Persisted saved filters,
background refresh, and bulk review actions need separate product decisions.
