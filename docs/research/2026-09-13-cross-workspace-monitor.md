# Cross-workspace activity monitor research — 2026-09-13

The rail already polls `/api/activity/summaries` when any workspace has activity, and the payload
contains only workspace IDs and counts. A dedicated surface is a low-risk way to turn those badges
into a triage view: workspace names, active/attention totals, and a bounded observation age.

The monitor should keep archived workspace names visible but avoid opening them, since bootstrap
rejects archived workspaces until restoration. Active rows can reuse workspace selection and Needs
attention navigation. Adding a shared observation timestamp makes stale data explicit without
introducing transcript or run-detail reads.
