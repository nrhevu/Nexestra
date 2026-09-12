# Run history recovery research — 2026-09-12

The product brief combines monitoring with dispatch and recovery. Nexestra already exposed a
workspace-wide run list and a server retry command, but the list stopped at inspection. GitHub's run
history pairs run status and attempt information with a per-run detail view; Codeg's recent releases
also emphasize that task state and IDs must remain visible while monitoring batches. These patterns
support a narrowly scoped recovery action on the failed row itself.

The UI now offers **Retry run** only for failed or interrupted attempts. It delegates all authority
to the existing server command, which checks archived threads, stale newer attempts, agent state,
and Worker assignment state. A successful request refreshes the current workspace projection so the
new attempt is visible without losing the user's filters; a failed request uses the existing error
surface. No batch or automatic retry policy is introduced.

References:

- [GitHub workflow run history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history)
- [Codeg releases](https://github.com/xintaofei/codeg/releases)
