# Durable plan provenance

The Master already creates durable Taskboard tasks before delegation, but the plan title was only
retained inside each task description. A generated plan identifier and bounded title make the source
of a task explicit in the board and preserve that context through export/import and restart without
introducing a second execution queue.

Upstream comparison keeps this intentionally narrow. [DeepSeek Harness' plan subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md)
uses a durable, replayable plan-mode event separate from the model transcript, while recent [Codeg
releases](https://github.com/xintaofei/codeg/releases) surface plan cards and approval-oriented
transitions. Nexestra now preserves plan identity on work items; a future plan-mode initiative should
address session-level mode events and review transitions separately from Taskboard task metadata.
