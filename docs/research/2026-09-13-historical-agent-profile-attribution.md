# Historical agent profile attribution research — 2026-09-13

Run history is the harness comparison surface. Resolving harness and model labels from the current
agent profile meant an edit could rewrite the apparent identity of every earlier run. That weakens
quality, latency, and cost review precisely when a user is tuning a profile.

The dispatcher now captures only bounded profile labels when it queues a run. History and its
per-agent aggregates prefer those snapshots, while legacy rows use the current profile so existing
workspaces remain readable. The labels contain no provider URL, API key, OAuth token, transcript, or
raw failure text. A profile change can produce multiple comparison entries for one agent ID, which
preserves the observed execution history instead of collapsing it into today's settings.

Pricing remains read-time because this slice does not define a billing-rate migration or invoice
model. A future decision can snapshot pricing separately if local estimates need the same guarantee.
