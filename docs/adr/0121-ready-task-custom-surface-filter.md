# ADR 0121: Ready-task custom surface filter

Status: Accepted

Custom surfaces may include the allowlisted `ready_tasks` action. A ready task is a selected-workspace
task with status `todo` and no queued or running Worker assignment. The card shows that live count and
opens Taskboard with a URL-backed, read-only ready filter that the user can clear.

The filter does not assign, dispatch, or mutate a task. Completed, failed, and interrupted assignment
history does not hide a todo task because it has no active Worker. Configuration still cannot supply
queries, code, URLs, or custom form fields.
