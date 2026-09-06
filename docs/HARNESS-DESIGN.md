# General-purpose harness design

This is the target design, not a claim that every subsystem is implemented. Read
[ARCHITECTURE.md](ARCHITECTURE.md) for the current runtime and [ROADMAP.md](ROADMAP.md) for status.
The product interpretation is in [Vietnamese](PRODUCT-VISION.vi.md).
See the editable [architecture and lifecycle diagrams](diagrams/harness.md). Their canonical JSON
passed schema and static Mermaid checks; no renderer acceptance is claimed.

## The central separation

Nexestra owns the **control plane**: contracts, permissions, state transitions, orchestration,
budgets, evidence and user decisions. A configurable assistant proposes goals and plans. Runtime
adapters execute bounded invocations using Codex, OpenCode plus a selected provider/model, or a
custom provider. Surfaces and chat are interaction clients of the same control plane.

An agent profile is a role/instruction set plus a runtime configuration. These are separate axes:
coordinator, researcher, author, designer, implementer and evaluator are roles; Codex/OpenCode/custom
HTTP are runtimes; the configured provider/model determines capabilities and cost. Do not hardcode
one “smart” model as coordinator or assume a coding CLI can only produce code.

Keep one Node/Hono process, React/Vite, and local files until measured needs justify a new service.
A graph engine, vector database, distributed queue or microservice mesh is not a prerequisite.

## Domain model and authority

| Object | Purpose | Who may change it |
| --- | --- | --- |
| Workspace | Resources, policies, surfaces and agent profiles | Local user through domain commands |
| Thread | Canonical conversation and its scoped working context | User/agent messages, append-only |
| Work Brief | Desired outcome, outputs, constraints, open questions, checks | User or scoped assistant drafts; user may confirm an exact revision |
| Goal | A pursuit of a particular brief revision with budget and stop policy | Coordinator proposes; control plane validates scope/authority |
| Plan | Versioned acceptance units and dependencies | Coordinator proposes changes; control plane checks invariants |
| Work unit | Behavior, input/output references, evaluator and lifecycle | Harness-controlled transitions; never a model-supplied `passing` boolean |
| Run / attempt | One invocation with exact context, capabilities and environment | Dispatcher and runtime adapter |
| Artifact version | Immutable output plus producer and source references | Producer submits; artifact service snapshots and identifies it |
| Evidence | A check against exact artifact and contract revisions | Trusted verifier records; producer claims are labeled as claims |
| Decision | Question, alternatives, answer and scope of authorization | User or pre-authorized policy, with provenance |
| Checkpoint | Verified resumable state and next action | Harness records after durable commit |

The first slice implements a thread-scoped Work Brief, its revisions and context injection. A
confirmed brief means agreed scope; it does not start a goal, expand permissions or prove completion.
Goals spanning multiple threads will reference the same versioned brief instead of copying its text.

## Five harness subsystems

**Instructions.** A short entry document routes to role instructions, domain skills, constraints,
and acceptance contracts. Separate user intent, developer policy and untrusted retrieved material.
Tool output and document text cannot grant permissions. A revision is a structured change, not a
new instruction hidden inside a generated artifact.

**Tools.** Use a single domain command layer from chat, surfaces and agent tools. Validation,
authorization, conflict checks, idempotency and event persistence happen there. Protocol-specific
adapters translate tools and events; they do not implement separate task lifecycles. Support
capability discovery and clearly report missing features instead of silently changing behavior.

**Environment.** A work unit declares required tools, network policy, input snapshots, output
locations and verification recipe. Code can use a Git worktree. Research, documents and design use
isolated assignment directories and immutable artifact promotion. Readiness checks run before the
first attempt. Do not promise OS isolation for a runtime that only constrains cwd or prompts.

**State.** Keep canonical, replayable records outside the model context. Each thread retains one
JSONL transcript for all participants. Domain state has one owner; indexes and UI counts are
projections. Every meaningful operation identifies workspace, goal, work unit, run, attempt and
revision as applicable. A fresh session reconstructs state without relying on hidden native-session
memory. Progress summaries reference the underlying events and outputs.

**Feedback.** The verifier operates on the frozen contract and candidate artifact, then records
evidence. A Worker response means an attempt ended, not that the requested behavior passed.
Failures include the failed criterion, observed behavior, evidence and a repair instruction. A
repair gets a bounded attempt; it cannot change the acceptance bar to hide a failure.

## Understanding intent without creating bureaucracy

Treat the brief as a living, visible hypothesis. Capture the original request and distinguish
explicit constraints, assumptions and unresolved questions. A small question can be answered
directly. For substantial work, expose a concise interpretation early; ask only questions whose
answers materially change scope, risk or value, and continue independent work when possible.

Surfaces should make correction cheap: revise an outcome, choose a design alternative, annotate an
artifact, or answer a question in context. Use expected revisions so a late model response cannot
erase a user's edit. Editing a confirmed brief invalidates that confirmation. A future executing
goal stays bound to its prior contract until a deliberate plan revision resolves the change.

“User confirmed the scope,” “user authorized an external action,” and “verification passed” are
different records. Do not turn all three into a single approve button.

## Initialization and continuity

An initializer produces a small readiness report: usable workspace, capabilities, one meaningful
smoke check, a first work unit, its verification method and stop policy. It does not spend an
unbounded session producing a giant plan. It may be the same model as the executor with different
instructions and capabilities.

At each continuation, assemble bounded context in this order: goal and frozen contract, current
work unit, relevant decisions, latest verified checkpoint, failure evidence, required inputs, then
recent conversation. Load other knowledge on demand. Prefer references and source provenance over
repeated copies of the entire workspace. Detect contradiction or obsolete summaries and follow
the canonical record.

Ending an attempt requires an explicit disposition: candidate produced, verified, blocked,
interrupted, failed, or needs a decision. Record remaining work and clean temporary resources. A
restart never silently replays a non-idempotent action whose outcome is unknown. It reconciles the
external result or asks for a decision.

## Work and verification lifecycle

The target work-unit states are `not_started`, `active`, `in_review`, `blocked`, `passing`, and
`cancelled`. Execution-attempt status is separate. A run may finish successfully while its work
unit remains in review. Human-owned checklist items can have manual completion, visibly distinct
from evidence-backed agent work.

Typical transitions:

- `not_started → active`: dependencies satisfied, capability checks pass, budget reserved and
  one work slot acquired.
- `active → in_review`: candidate outputs durably captured, with producer identity and revision.
- `in_review → passing`: all required checks pass for the same contract/output versions.
- `in_review → active`: a repair is actionable, authorized and within retry/budget limits.
- Active states may become `blocked` with a concrete reason and recovery action; cancellation
  interrupts the process and preserves all committed evidence.
- Changing the accepted output or required criteria invalidates prior acceptance; historical
  evidence stays attached to the old versions.

Use WIP=1 per execution lane and per mutable output set. A graph may parallelize independent
subtasks under one accepted goal. Two Workers must not concurrently write the same artifact or
branch. Workspace-wide concurrency is an explicit policy, not accidental fan-out.

| Layer | Code | Research / document / design |
| --- | --- | --- |
| Structural | Typecheck, lint, schema, syntax | Required fields, readable files, references, document structure |
| Behavior | Unit/integration behavior and resource handling | Source entailment, calculations, rubric, accessibility and interactions |
| End to end | Real user workflow on the candidate build | Open/render the actual artifact, follow citations, exercise prototype, review in destination format |

An independent evaluator can be another runtime or a separate role with a fresh context. A second
agent is not automatically independent: shared blind spots, editable rubrics and missing evidence
still produce false confidence. Deterministic checks take precedence where available. Subjective
goals keep human acceptance or a recorded rubric judgment explicit.

## Loop engineering

A loop is a goal, independent verification and a stop policy. Persist its authority and budget:
maximum elapsed execution time, attempts, tool rounds, concurrency and spend/token limits where
usage is available. Unknown provider usage is unknown, not zero. Reserve budget before dispatch so
parallel children cannot each consume the full parent budget.

Stop on accepted output, cancellation, exhausted budget, unresolved required decision, failed
readiness, or repeated failure without new evidence. A heartbeat resumes only eligible work; it
does not manufacture a new user request or reset retry counters. Distinguish paused/recoverable from
terminal failure. Notifications report meaningful state changes or decisions, not every heartbeat.

The six primitives map to domain services: resumable scheduled triggers, isolated environments,
skills, connectors, scoped child runs, and external durable state. No one primitive replaces the
others. A connector exposes capabilities; it does not decide when a user wanted them used.

## Graph engineering

Begin with one bounded loop. Introduce a graph when at least three are true: independent
decomposition, useful conditional routes/rollbacks, valuable checkpoints, verifiable outputs, and
coordination benefits exceeding its cost. Record that choice in the plan; don't use a graph merely
to display many agents.

A graph definition contains typed nodes, input/output schemas, edges and routing predicates,
shared-state references, join conditions, failure policy, and checkpoint locations. Nodes can be
full agents or deterministic functions. The scheduler validates dependencies, rejects cycles unless
represented as an explicit bounded loop node, applies resource ownership and checks results before
unlocking successors. Every retry belongs to the same logical node and budget.

Keep generator, critic, integrator and goal-review responsibilities legible. Goal review can ask
whether the objective is still useful; an artifact verifier only checks the selected objective.
Rejection routes to a local repair or a user decision, not a wholesale rerun. A graph version is
immutable once started; edits create a new version with an explicit migration of remaining work.

## Surfaces and the orchestration cost

A Taskboard, Whiteboard, Knowledge view, or generated form must observe the same domain objects.
Each supports a bounded context export that an agent can understand without reconstructing pixels.
Every user action is semantically meaningful: it targets stable IDs and expected revisions. See
[surface extensions](SURFACE-EXTENSIONS.md).

The user should receive a review packet with outcome, changed artifact, criteria/evidence,
tradeoffs, and one next decision when needed. Aggregate repetitive status and expose details on
demand. Preserve audit evidence even if transient activity disappears from chat. Review bandwidth
is a resource: cap unresolved review work and prioritize by importance, uncertainty and reversibility.

## Mapping the 14 lectures to acceptance criteria

| Lecture | Mechanism | Acceptance scenario | Current location / planned work |
| --- | --- | --- | --- |
| 1–2 | Five explicit subsystems, verifier authority | A confident unsupported answer cannot pass the work unit | Task completion requires a separate human review; executable verifiers planned |
| 3 | Workspace as record, provenance | A fresh session explains work using persisted files only | Canonical threads, knowledge, Work Briefs and persisted goal checkpoints |
| 4 | Router instructions, scoped context | A role loads only relevant references and preserves critical constraints | `AGENTS.md`, skill discovery; context packer planned |
| 5 | Checkpoints and recovery | Restart preserves accepted work and marks ambiguous side effects for reconciliation | Interrupted assignment recovery and explicit goal resumption implemented |
| 6 | Initialization phase | Missing capability prevents dispatch with a repairable readiness report | Runtime availability exists; environment recipes planned |
| 7 | Ownership and WIP | Two conflicting tasks cannot acquire the same output slot | Per-agent queues/worktrees exist; resource scheduler planned |
| 8 | Behavioral acceptance units | Model cannot edit passing state or loosen the active contract | Task criteria, frozen revisions and review transitions enforced |
| 9 | Generator/verifier separation | Producer-supplied evidence is labeled and cannot self-approve | Independent human review for frozen contracts; legacy completed records remain unverified |
| 10 | Three-layer checks | An artifact passing syntax but failing a user flow remains unaccepted | Repo has integration/UI tests; product verifier service planned |
| 11 | Events plus acceptance records | User can trace a decision to its attempt, artifact and evidence | Runs/tools, immutable human reviews and hashed non-Git output snapshots |
| 12 | Clean handoffs and simplification | Resume smoke test works after every checkpoint | Repo development rules; product cleanup/checkpoint service planned |
| 13 | Persisted loop goal/budget/stop policy | Exhausted or cancelled loops never silently restart | Persisted goals, attempt/deadline limits, no restart replay; token accounting planned |
| 14 | Typed graph with explicit joins and routes | Failed branch does not unlock a join; local repair preserves passing siblings | Planned after loop acceptance is proven |

## Sources and limits of inference

The user's [Harness Engineering course](https://walkinglabs.github.io/learn-harness-engineering/en/lectures/lecture-01-why-capable-agents-still-fail/)
and supplied L1–L14 keynote motivate this design. The numerical anecdotes in the keynote are not
product benchmarks or a reason to maximize agent count.

Anthropic describes initialization, incremental work, durable progress and end-to-end verification
as mechanisms for long-running coding sessions, while explicitly leaving broader-domain
generalization and the best agent topology open. Applying these ideas to research, documents and
design is a Nexestra design inference that needs separate acceptance scenarios, not an established
performance guarantee. [Primary engineering source](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
