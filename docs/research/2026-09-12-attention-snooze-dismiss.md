# Attention snooze and dismissal research — 2026-09-12

The existing attention projection is intentionally derived from live run and Taskboard metadata.
That keeps it accurate, but leaves no local control for a user who has seen an issue and wants it out
of the way temporarily. A small workspace-scoped state record provides that control without mutating
the source task or run.

The implementation stores only a derived attention ID and either a server-generated expiry or the
time of dismissal. Snoozes are bounded to seven days by the shared contract; the browser currently
offers one hour. Dismissals are hidden only while the source item's `updatedAt` is no newer than the
dismissal timestamp, so retries and state transitions naturally surface fresh work. Filtering is
performed on the server for bootstrap and activity snapshots, preserving workspace isolation.

This remains a convenience layer rather than a notification system: there is no audit history,
desktop notification, cross-workspace rollup, or multi-user synchronization.
