# Run history telemetry row copy research — 2026-09-13

Run history is the harness's comparison surface for heterogeneous agents. The existing JSON and CSV
exports are bounded to loaded rows, but a user evaluating one run should not have to export and trim
a whole page. A read-only per-row handoff provides that smaller unit.

The chosen slice adds a versioned JSON row envelope containing only existing telemetry projections:
run and trigger IDs, status, attempt, timing, provider usage, bounded failure kind, agent harness/model
labels, thread/task labels, and derived cost signals. It deliberately omits transcript text and raw
provider errors. The browser first attempts `navigator.clipboard.writeText`; a rejected or unavailable
clipboard exposes a read-only manual-copy textarea. No API or persistence change is needed.

The row remains tied to the loaded page snapshot and may become stale as a run changes. A future
signed or server-generated evaluation packet would need a separate integrity and retention policy.
