# Plan summary export research — 2026-09-13

The original harness brief calls for research and debate surfaces that reduce repeated context
copying. Taskboard already computes a useful plan projection, while the full workspace archive is
too broad for routine handoff because it includes transcripts and other workspace artifacts.

The next narrow seam is a versioned client-only JSON packet named `nexestra.plan-summary`. It carries
only plan/task identity, bounded progress counts, worker profile labels, and assignment status. A
200-plan and 200-task cap keeps browser memory and downstream prompt size predictable; a truncation
flag and full per-plan counts make a partial packet honest. The selected bootstrap snapshot is the
workspace boundary, so no cross-workspace query is needed.

This complements the existing Taskboard cards without creating a second persistence path or a new
approval lifecycle. Future plan approval can consume the packet's durable IDs, but the export itself
never dispatches work and never includes transcripts, prompts, credentials, or repository paths.
