# Run cost budget signal research — 2026-09-12

The harness already lets a user compare local token-based estimates across agents, but a total alone
does not surface an unexpectedly expensive individual run. A small per-agent limit makes that signal
visible without pretending to enforce provider billing controls.

The selected design stores the optional limit in the agent pricing profile and derives comparison
fields from the same usage and pricing inputs used by run-history cost telemetry. The UI marks rows
whose observed estimate is above the limit and adds a filter-scoped count. Unknown usage remains
unknown, and the feature never writes secrets or raw provider payloads to transcripts.

Follow-up work can add provider-native spend controls only when a provider supplies a reliable,
authenticated budget API; this local signal remains useful for heterogeneous custom agents.
