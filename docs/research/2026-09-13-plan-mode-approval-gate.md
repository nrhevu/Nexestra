# Plan-mode approval gate research — 2026-09-13

The current custom-provider tool loop can create and delegate a plan in one invocation. That is a
good autonomous default, but it makes the Plan mode toggle too weak for deliberate debate and review.
An exact provider pause/resume would require durable provider messages, tool-call continuation state,
and callback recovery after restart.

A two-phase gate gives the useful part now. When Plan mode is active, persist one shared approval
state on all generated tasks, stop the Master tool loop after it presents the plan, and let the user
approve or reject from Taskboard. Delegation checks the persisted task state, so the invariant holds
after restart and across both automatic and manual entry points. Workspace scoping, atomic plan
updates, and active-assignment rejection prevent one review action from changing unrelated work.
