# Plan step dependency research — 2026-09-13

The harness brief combines planning with heterogeneous Worker dispatch. Durable plan identity and
summary cards make the plan visible, but they do not yet express that one step must follow another.
Approval would require a larger pending-plan lifecycle, while dependency edges can improve execution
ordering using the existing Task and assignment state.

The bounded design adds one-based `dependsOn` step numbers to Master plan input, validates range and
cycles before task creation, then resolves them to generated task IDs. The store keeps the graph
workspace- and plan-scoped; the dispatcher refuses explicit delegation until every prerequisite is
terminal `done`. Taskboard exposes the distinction between ready and dependency-blocked work.

Legacy plans omit the field and remain independent. No automatic dispatch, approval, transcript
content, repository path, or credential is added by this feature.
