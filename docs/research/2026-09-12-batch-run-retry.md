# Batch run retry research — 2026-09-12

Run history already has a guarded retry endpoint for one failed or interrupted run. A page-scoped
selection action can reuse that contract without new persistence or authorization behavior. The
UI limits selection to retryable terminal states and dispatches sequentially, preserving the
existing stale-attempt and archived-thread checks for every run.

This is a product usability slice; no provider calls are made by the browser tests.
