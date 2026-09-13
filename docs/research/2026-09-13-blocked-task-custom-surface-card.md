# Blocked-task custom surface card research — 2026-09-13

The harness brief calls for customizable domain surfaces that help a person coordinate work across
heterogeneous agents. The existing Taskboard card counts every unfinished task, which hides the
small set that needs intervention. A bounded `blocked_tasks` card gives a sharper signal while
reusing the existing Taskboard route and task model.

The projection is computed in the browser from the selected workspace bootstrap data, so foreign and
archived workspace tasks cannot leak into the count. The action is added to the same Zod allowlist as
other built-in cards; labels, descriptions, and destinations remain controlled by the application.
The current slice does not add a server-side filter or change task state.
