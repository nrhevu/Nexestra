# Approved-plan batch dispatch research — 2026-09-14

The approval gate leaves a useful gap between review and execution: several independent plan tasks
require the same manual Worker and repository choices. A batch action should reuse the current
single-task delegation endpoint so every successful task keeps its canonical user message and all
server-side checks remain the source of truth.

The client can safely offer only the subset that is already dependency-ready in its loaded plan:
approved `todo` tasks with no assignment history and only completed prerequisites. It must present
that subset with the selected Worker and repository before dispatch, issue calls sequentially, stop
after the first rejected request, then reload state. This lowers repeated UI work without pretending
the original Master invocation can be resumed or that unfinished dependent tasks are safe to start.
