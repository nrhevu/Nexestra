# Cross-workspace run telemetry research — 2026-09-12

Codeg's token-usage view groups provider-reported arithmetic across folders, agents, models, and
sessions while warning that it is not provider billing metering. Nexestra already had workspace-
scoped run history, pricing profiles, and over-budget signals, but no safe way to compare those
aggregates across workspaces.

The selected extension adds a count-only API projection with explicit coverage. It reuses the
workspace run-history summary, keeps transcript and error payloads out of the response, supports a
single workspace for isolation checks, and leaves the paged `/api/runs` contract untouched.
