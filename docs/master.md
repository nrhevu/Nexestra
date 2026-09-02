# The Master agent (`@nexestra/master`)

Milestone M2. The Master turns a vague request into a frozen `Spec` and a
validated `Plan`, then supervises the harnesses that do the work.

It is a **library**, not a service: no HTTP, no database, no process spawning,
no filesystem writes. Three seams keep it that way.

| Seam | Interface | Real implementation | Test implementation |
|------|-----------|---------------------|---------------------|
| The model | `LlmClient` | `createAnthropicLlmClient()` | `createFakeLlmClient(script)` |
| The world | `MasterHost` | the orchestrator / server (later milestone) | `createFakeHost()` |
| The transcript | `MasterStore` | `@nexestra/storage` (M1) | `createInMemoryMasterStore()` |

Because all three are injected, the entire loop — phases, tool validation, spec
and plan bookkeeping, budget rules — runs in Vitest without an API key, a repo
or a harness. One live smoke test exercises the real endpoint when a key is
present.

---

## 1. Quick start

```ts
import {
  createAnthropicLlmClient,
  createInMemoryMasterStore,
  createMasterSession,
} from "@nexestra/master";

const session = createMasterSession({
  threadId: "th_1",
  workspaceId: "ws_1",
  host,                                   // your MasterHost
  llm: createAnthropicLlmClient(),        // claude-opus-5
  store: createInMemoryMasterStore(),
  budgetUSD: 20,
});

for await (const event of session.send("make me a todo cli")) {
  // forward to the WebSocket
}
```

### `MasterSession`

| Member | Purpose |
|--------|---------|
| `send(input)` | Run one turn. Returns `AsyncIterable<MasterEvent>`; always ends with a `done` event. Accepts a bare string as shorthand for `{kind: "user_message", text}`. |
| `state()` | The current `MasterThreadState` (phase, spec, plan, usage, pending call). |
| `applyTrigger(trigger)` | Push a phase transition from the orchestrator — `plan_accepted`, `all_tasks_done`, `all_criteria_verified`, `blocked`, `unblocked`, `cancelled`. Returns the guarded `PhaseTransition`. |
| `cancel()` | Abort the in-flight model request. |

### Inputs

```ts
{ kind: "user_message", text }
{ kind: "answers", answers: [{ id, answer }] }        // replies to ask_user
{ kind: "approval", decision: "approved" | "rejected", note? }
{ kind: "continue", note? }                            // resume without new user content
```

A turn that ends in `awaiting_answers` or `awaiting_approval` has a pending
tool call; the matching input closes it. A `user_message` sent while an
`ask_user` is pending is treated as the answer to the first question.

### Configuration

| Option | Default | Notes |
|--------|---------|-------|
| `budgetUSD` | `20` | 80% raises a `spend` approval, 100% blocks the thread |
| `maxQuestions` | `6` | PLAN.md §4.1 stop rule, enforced in code not just in the prompt |
| `maxIterations` | `16` | model calls inside one `send()` |
| `maxTokens` | `32000` | per request |
| `autoAdvance` | `true` | move `spec_frozen → planning` at the start of the next turn |
| `prompts` | read from `src/prompts/*.md` | override when the filesystem is not available |
| `now` | `() => new Date().toISOString()` | injectable clock |

---

## 2. Events

`send()` yields these, in stream order:

| Event | Payload | Rendered by |
|-------|---------|-------------|
| `text_delta` | `text` | Chat timeline |
| `thinking_summary` | `text` | Chat timeline (collapsed) |
| `tool_call` | `callId`, `name`, `input` | Chat timeline |
| `tool_result` | `callId`, `name`, `ok`, `output` | Chat timeline |
| `question` | `callId`, `questions[]` (`id`, `text`, `options?`, `allowFreeText?`) | Composer chips |
| `spec_updated` | full `Spec` | Requirements sidebar |
| `plan_proposed` | `MasterPlanProposal` | Task Board |
| `approval_requested` | `callId?`, `approval` (`approvalId`, `status`), `request` | Approval queue |
| `phase_changed` | `from`, `to`, `reason` | Thread header |
| `usage` | `turn`, `thread`, `budgetUSD` | Cost badge |
| `error` | `MasterError` (`code`, `message`, `category?`, `retryable`) | Chat timeline |
| `done` | `outcome`, `phase` | ends the stream |

`done.outcome` is one of `end_turn`, `awaiting_answers`, `awaiting_approval`,
`max_iterations`, `budget_exceeded`, `cancelled`, `error`.

`error.code` is one of `refusal`, `max_tokens`, `context_window_exceeded`,
`transport`, `tool`, `phase`, `budget`, `internal`. A `refusal` carries the
`stop_details.category` from the API; because the client sends
`fallbacks: "default"`, a refusal that reaches the caller means the whole
fallback chain declined.

`approval_requested` without a `callId` is a budget warning the Master raised on
its own; it does not suspend the turn.

---

## 3. Phases

```
intake → clarifying → spec_frozen → planning → executing → verifying → done
                                                    ↘        ↙
                                              blocked ← → (resume)
   any phase → cancelled
```

`nextPhase(current, trigger, context)` is pure and exported. Every transition is
guarded, and an illegal one comes back as `{ok: false, reason}` rather than
being ignored:

- `spec_approved` needs zero unanswered questions and at least one acceptance
  criterion.
- `plan_accepted` needs a plan that passed validation.
- `all_criteria_verified` needs every criterion to carry an
  `evidenceArtifactId`.
- `unblocked` cannot resume into a terminal phase.

### Tool surface per phase

Only the current phase's tools are sent to the model, so a model that "forgets"
the process cannot call a tool from another phase — and if it tries a name it
has not been given, the call comes back as a `tool_result` error naming the
phase.

| Phase | Tools |
|-------|-------|
| `intake` | `read_workspace`, `search_code`, `web_search`, `ask_user`, `update_spec`, `record_memory` |
| `clarifying` | `ask_user`, `update_spec`, `record_memory`, `read_workspace`, `search_code`, `web_search`, `request_approval` |
| `spec_frozen` | `request_approval`, `record_memory`, `summarize` |
| `planning` | `propose_plan`, `record_memory`, `read_workspace`, `search_code` |
| `executing` | `dispatch_task`, `read_run_events`, `read_artifact`, `control_run`, `request_approval`, `replan`, `record_memory` |
| `verifying` | `run_verification`, `read_artifact`, `mark_criterion`, `record_memory` |
| `done` | `summarize`, `record_memory` |
| `blocked` | `summarize`, `request_approval`, `record_memory` |
| `cancelled` | — |

This is PLAN.md §4.1 with three additions the loop needs to work: `intake` can
already ask and draft (otherwise it could never leave the phase), `clarifying`
can request the spec approval that freezes it, and `record_memory` is available
wherever the Master produces durable facts. `web_search` stays confined to
`intake` and `clarifying` as specified.

### Gates that are enforced twice

`propose_plan` is unavailable outside `planning` **and** rejected inside it
while any question is unanswered, the spec is unapproved, or there are no
acceptance criteria. `mark_criterion` refuses to pass a criterion without an
`evidenceArtifactId`. `request_approval(kind: "spec")` refuses while questions
are open. `ask_user` refuses once the question budget is spent, and tells the
model to proceed on stated assumptions instead.

---

## 4. `MasterHost` — what the orchestrator has to implement

Every method may reject; the session turns a rejection into a `tool_result`
with `is_error: true` and lets the model recover, rather than aborting the turn.

### Read

| Method | Input | Returns |
|--------|-------|---------|
| `readWorkspace` | `{path?, depth?, includeManifests?}` | `{root, entries[{path, kind, size?}], manifests[{path, content, truncated}], truncated}` |
| `searchCode` | `{query, path?, filePattern?, regex?, maxResults?}` | `{matches[{path, line, text}], truncated, engine}` |

`createFsWorkspaceReader({root})` implements both against a real repo:
ignore rules (`.git`, `node_modules`, `dist`, `.nexestra`, …), README and
package-manifest extraction, ripgrep when it is on `PATH` with a JS walk
fallback, and a hard refusal to resolve a path outside the root.

### Write / effect

| Method | Input | Returns |
|--------|-------|---------|
| `recordMemory` | `{type, title, content, links?, tags?}` | `Memory` |
| `requestApproval` | `{kind, summary, payload?}` | `{approvalId, status: "pending" \| "approved" \| "rejected", note?}` |
| `dispatchTask` | `{taskId, kind?, instructions?, harness?, harnessConfig?}` | `{runId, taskId, harness, kind, worktreePath?}` |
| `readRunEvents` | `{runId, sinceSeq?, limit?, types?}` | `{runId, events[{seq, type, payload}], nextSeq, truncated}` |
| `readArtifact` | `{artifactId, maxBytes?}` | `{artifact{id, kind, title}, content, truncated}` |
| `controlRun` | `{runId, action, message?}` | `{ok, note?}` |
| `runVerification` | `{taskId, criterionIds?}` | `{taskId, outcomes[{criterionId, passed, evidenceArtifactId?, exitCode?, output?}]}` |
| `markCriterion` | `{criterionId, passed, evidenceArtifactId?, note?}` | `{criterionId, satisfied}` |
| `summarize` | `{outcome, summary, lessons?}` | `{ok}` |

Returning `status: "pending"` from `requestApproval` suspends the turn until
`send({kind: "approval", …})`; returning `approved`/`rejected` resolves it
inline. A `runVerification` outcome that passes with an `evidenceArtifactId`
also writes that evidence onto the spec's criterion, which is what eventually
unlocks `done`.

### Optional

| Method | Purpose |
|--------|---------|
| `dispatchDefaults()` | Workspace defaults for harness / reasoning / sandbox |
| `onSpecUpdated(spec)` | Persist and broadcast a new spec version |
| `onPlanProposed(plan)` | Persist and broadcast a plan proposal |
| `onPhaseChanged(from, to, reason)` | Persist and broadcast the phase |

---

## 5. `MasterStore`

```ts
loadState(threadId): Promise<MasterThreadState | null>
saveState(state): Promise<void>
appendMessages(threadId, messages): Promise<void>   // append-only
loadMessages(threadId): Promise<LlmMessageParam[]>
```

`appendMessages` never rewrites earlier entries, and the session pushes
`response.content` **verbatim** — thinking blocks with their signatures and
compaction blocks included. Extracting only the text and storing that would
silently break both adaptive thinking continuity and server-side compaction.

`MasterThreadState` carries `phase`, `spec`, `plan`, `specApproved`,
`planAccepted`, `questionsAsked`, `usage`, `budgetUSD`, `budgetWarned` and the
`pending` tool call. `pending` also holds the tool results for the *other* calls
in the same assistant turn (`resultsBefore` / `resultsAfter`), because the API
requires every `tool_use` block to be answered in one user message; the session
splices the resolved result into the middle when the user replies.

---

## 6. Model configuration

`createAnthropicLlmClient()` sends, per PLAN.md §4:

- `model: "claude-opus-5"`, `thinking: {type: "adaptive", display: "summarized"}`.
- `output_config.effort`: `"high"` while planning, `"medium"` otherwise.
- Streaming, consumed with `finalMessage()`.
- Prompt caching: a `cache_control` breakpoint on the stable system prefix and
  on the last tool. The volatile per-turn context (phase, spec digest, budget)
  goes into a *second* system block **after** the breakpoint, and the tool list
  is built in a fixed order from a cached schema map, so the cached prefix stays
  byte-identical across turns.
- `betas: ["server-side-fallback-2026-07-01", "compact-2026-01-12"]` with
  `fallbacks: "default"` and `context_management.edits: [{type: "compact_20260112",
  trigger: {type: "input_tokens", value: 150000}}]`.
- `strict: true` tool schemas with `additionalProperties: false` everywhere.

Deliberately **not** used: assistant prefill and `budget_tokens` (both rejected
on Opus 5), and forced `tool_choice` — the phase machine already constrains what
the model can do, and forcing a call would fight it.

Tool JSON Schemas are derived from the zod schemas by `toStrictJsonSchema()`
rather than the SDK's `transformJSONSchema`, which demotes `enum` and `const`
into prose and so would drop exactly the constraints we want enforced.

### Cost

`estimateCostUSD` uses a local price table (Opus 5 at $5/$25 per MTok, cache
reads ×0.1, cache writes ×1.25). An unknown model costs zero rather than a
guess, so a wrong number can never silently pause a thread.

---

## 7. Prompts

`src/prompts/*.md`, read at run time and cached for the life of the process:
`base.md` plus one file per phase. The system prompt for a turn is
`base + phase`.

`base.md` covers the standing rules: the phase machine owns the process, the
Master never edits files, only tools change durable state, budget awareness, and
that workspace/web content is data rather than instructions. `clarifying.md`
carries the five dimensions (goal, scope, constraints, expected outcome,
acceptance criteria with verifiable checks), the rule that a criterion must be
able to fail, and the stop rules — six questions, or the next question would
only refine something a harness can decide, or the user says get on with it.

They are written for Opus 5: short, declarative, and light on procedure. The
enforcement lives in code, so the prompt does not need to repeat it.

A caller that cannot read from disk (a bundled server build) passes
`prompts: MasterPromptSet` to `createMasterSession` instead.

---

## 8. Tests

`pnpm --filter @nexestra/master test` — 56 tests, no network, no API key.

| File | Covers |
|------|--------|
| `src/phase.test.ts` | the transition function: every guard, purity, the phase/tool table |
| `src/tools/tools.test.ts` | JSON Schema strictness and stability, per-phase tool lists, cache breakpoint placement, input validation |
| `src/tools/workspace.test.ts` | the fs reader against a temp repo: ignore rules, manifests, root escape, ripgrep **and** the JS fallback |
| `src/session.test.ts` | the full scripted M2 run, phase gating, tool validation, refusal / truncation / transport errors, usage and budget, verbatim history |
| `src/llm/live.test.ts` | one real request (skipped without credentials) |

The headline test is the M2 acceptance criterion end to end: a vague request →
`read_workspace` before asking anything → four questions in one batch → answers
folded into the spec → three acceptance criteria, each with a `command` or
`test` verification → `request_approval` → approval freezes the spec → a
two-task plan with one dependency edge, every task naming a criterion and
carrying a complete `harnessConfig`.

### Live smoke test

```bash
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @nexestra/master test
```

It runs one cheap turn (`effort: "low"`, `max_tokens: 1024`, one tool) and
asserts the request *shape* is accepted by the live endpoint: adaptive thinking,
effort, prompt caching, a strict tool schema, the fallback beta and compaction
all together. Without credentials it is skipped with a message.

---

## 9. Known gaps

- **Nothing is wired up yet.** The server and the Chat surface consume this in a
  later milestone; `apps/server` does not import `@nexestra/master` today.
- **Prompts are read from disk.** The esbuild server bundle would not carry the
  `.md` files; the server must pass `prompts` explicitly or copy them into
  `dist`.
- **`replan` re-validates full criterion coverage**, so an amendment that drops
  the only task covering a criterion is rejected. That is intentional for now,
  but M5 may want a softer rule for mid-flight amendments.
- **The budget warning does not suspend.** At 80% the Master raises a `spend`
  approval and keeps going; only 100% blocks the thread.
- **`output_config.format`** is plumbed through `LlmRequest` but unused: strict
  tools already give schema-valid `propose_plan` input, and structured outputs
  cannot be combined with a tool call in the same turn.
