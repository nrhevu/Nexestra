# Research: task context in run history

Run history already compares agent, conversation, status, duration, usage, cost, and ratings. A
delegated Worker run is still hard to identify when a workspace has many conversations because the
row only shows the thread name. Assignment IDs are durable run IDs, and the store already retains a
workspace-scoped task title, so a small derived field can close that monitoring gap.

The implementation maps each listed run ID to its assignment and task, redacts the title, and emits
it only when the mapping exists. The browser shows `Task: …` beside the agent and conversation. This
keeps ordinary runs and legacy assignments honest while giving users enough context to choose which
Worker result to inspect. Task title is intentionally not a new filter or sort key; those would need
cursor and pagination decisions beyond this slice.
