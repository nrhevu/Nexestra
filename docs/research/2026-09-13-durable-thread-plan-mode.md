# Durable thread plan mode

DeepSeek Harness describes plan mode as a log-only, replayable session event separate from the model
transcript. Nexestra applies that idea to its canonical per-thread JSONL: `plan.mode` is durable state,
while the UI and runtime derive a bounded boolean from the latest event and thread metadata.

The first slice is intentionally soft. It gives the Master explicit planning guidance without silently
changing access or execution policy. Approval-oriented exit flows and step-boundary pending changes
remain future work.
