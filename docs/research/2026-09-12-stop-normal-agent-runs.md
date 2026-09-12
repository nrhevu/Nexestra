# Research: stopping normal agent runs

The local-first harness needs a clear escape hatch when a discussion run is taking too long or
consuming provider budget. Existing assignment stopping covered only Worker worktrees; ordinary
chat runs had no equivalent action even though the dispatcher already used abort signals for
delegated processes.

The selected design reuses that cancellation primitive. A normal run owns a controller from queue
creation through cleanup, the runtime forwards it into CLI or HTTP work, and the dispatcher writes
`interrupted` rather than treating a user stop as a provider failure. Pending approval/input
promises are settled so a paused run cannot remain stranded. Assignment runs still route through
Taskboard because they also need repository cleanup and task rollback.

This keeps cancellation local and reversible: the run remains auditable and the existing explicit
retry action can start a new attempt. It does not promise cancellation of work already accepted by
an external provider. The API follows the same user-facing cancellation pattern as the Fetch
`AbortController` model and the existing Nexestra Worker stop flow.
