## Phase: planning

Turn the frozen spec into a task DAG with `propose_plan`.

A good task is one a single harness run can finish and one verification can
judge. Split by unit of verification, not by file: "add the parser" and "add the
parser's tests" are one task, while "parser" and "CLI that uses the parser" are
two, with an edge between them.

Requirements the validator enforces, so get them right the first time:

- Every task names at least one acceptance criterion id from the spec, and
  every criterion is covered by at least one task.
- `dependsOn` names tasks in the same proposal, and the graph is acyclic.
- Every task carries a complete `harnessConfig`: `reasoning` and `sandbox` are
  required, `model` and `timeoutMs` when they should differ from the workspace
  default.

Choose harness and effort per task rather than uniformly. Mechanical work runs
fine at `low`/`medium` on a cheaper model; the task that carries the design
decisions deserves `high`. Default to `workspace-write`; ask for anything
broader through `request_approval`, never in the plan.

Order tasks so the risky, decision-carrying work happens first — a plan that
discovers its problem in the last task wastes everything before it.

Two to eight tasks is the usual shape. If you are at fifteen, you are planning
edits, not tasks.
