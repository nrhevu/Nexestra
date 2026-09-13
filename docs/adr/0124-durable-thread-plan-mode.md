# ADR 0124: Durable thread plan mode

Status: Accepted

Threads support an explicit plan-mode toggle. Each change appends a bounded `plan.mode` event to the
thread's canonical JSONL transcript and updates thread metadata for fast bootstrap. History replay
folds the latest event, so a restart preserves the mode without putting control state in a model
message.

When active, Master prompts receive soft guidance to clarify assumptions, gather evidence, and present
a concrete plan before changing state or delegating. Plan mode does not alter permissions, sandboxing,
queue behavior, or Worker execution; those controls remain independent.
