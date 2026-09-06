# Nexestra workspace and harness development

## Active objective

Build a general-purpose local workspace for research, documents, design and code. The user asked
for at least four hours of continued implementation and verification starting **2026-09-06
18:49:52 UTC** (2026-09-07 01:49:52 Asia/Ho_Chi_Minh). **Do not finish the session before
2026-09-06 22:49:52 UTC** unless the user redirects or an unavoidable blocker prevents progress.
Use the time for substantive work, not waiting out the clock.

Working branch: `codex/workspace-harness-foundation`.
Working tree: `/private/tmp/nexestra-workspace-harness`.
Original checkout is clean and remains on `master`.

## Completed checkpoint: shared Work Briefs

- General-purpose work brief contract, append-only revisions in the canonical thread JSONL,
  expected-revision conflicts, optional scope confirmation, redaction, HTTP API, Master read/draft
  tools, and pinned context in Codex/OpenCode and both custom HTTP protocols.
- Work briefs surface, chat link, shared built-in metadata catalog, and three editable architecture
  diagrams. Product vision, target harness design, extension contract, roadmap and ADR 0017 recorded.
- Fixed real/declared path mismatches for symlinked workspaces discovered by the full harness suite.
  Added a portable alias-boundary test. Made the TERM→KILL test wait for an observed signal handler.
  Disabled Node's experimental storage in test workers so jsdom owns browser storage.
- **Verified:** `pnpm check` passed at 2026-09-06 19:10 UTC: 150 tests, lint, types and production build.
  Browser QA passed save/open-question/confirm/chat-context flows at 1280px dark and 960px light,
  with no console errors. Browser runner was an explicit offline fixture, not a live provider.
- Mermaid canonical schema validation and static lint passed; no renderer acceptance claimed.

## Completed checkpoint: task contracts and human acceptance

- Typed research/document/design/code tasks, structured criteria, revisioned task requirements,
  frozen per-assignment contracts, atomic WIP per task, and dispatch revision comparison.
- Successful Workers move tasks to In review; only a separate human review with criterion evidence
  can accept an assigned task. Changes requested reopens it; prior reviews remain immutable.
- Added review API, Taskboard column, criterion editor, explicit manual-completion label and review UI.
  Browser QA caught and fixed a misleading stopped-process toast and unreadable light-theme text.
- `pnpm check` passed at 19:38 UTC: 159 tests, lint, types and build. After the final header-color-only
  fix, production Vite build and browser visual QA passed; no browser errors. Offline fixtures only.
- ADR 0018 documents limits: human observations are not executable checks; artifact snapshots and
  full-access-agent isolation are still outstanding.

## Completed checkpoint: general work execution and captured outputs

- Unified manual/Master dispatch, persisted explicit Taskboard user mentions, asynchronous start,
  shared serial Worker queue, cancellation, terminal-state protection, atomic task/assignment writes.
- General non-Git directories with TASK.md and outputs/, Codex/OpenCode task instructions,
  human Start Worker UI, structured criteria required, and read_tasks for new-session resumption.
- Generated output artifacts in the canonical reply, SHA-256 manifests, bounded capture excluding
  symbolic/hard links and known stored credentials, immutable copies, review hash validation.
- `pnpm check` passed at 20:01 UTC: 174 tests, lint, types and production build. Browser QA at
  20:04 UTC passed Taskboard start → generated document → inspect captured bytes → human acceptance.
  All runs used explicit offline fixtures; no live provider calls. ADR 0019 records remaining gaps.

## Completed checkpoint: declarative extensible surfaces

- Table, board, canvas and document host renderers, typed bounded manifests, import/export, record
  editing/position/color, archive/restore, enable/disable, selection context and preserved conflict drafts.
- Shared store/API/Master commands, workspace/author enforcement, edit permission, CAS revision writes,
  redaction including escaped credentials, invalid-schema protection, restart persistence and examples.
- `pnpm check` passed with 186 tests, lint, types and production build. Browser QA passed creating a
  Vietnamese whiteboard note, save/reload, selected context copy, archive/restore, enable/disable and
  dark/light themes. No browser errors. Visual QA caught and fixed native button borders and padding.
- ADR 0020 records limits: no executable plugin runtime, canvas edges/freehand/zoom, history/undo,
  automatic schema migrations or Worker CLI surface-tool bridge.

## Completed checkpoint: durable review-driven goals

- Frozen ordered task scope and Work Brief snapshot, explicit user Start/Pause/Resume/Cancel,
  atomic attempt admission, original elapsed-time deadline, one active goal/workspace and WIP=1.
- Successful execution waits for human evidence review; acceptance advances, changes requested
  retries within budget, failure blocks. Paused reviews update checkpoints without new execution;
  final matching acceptance can complete the goal. Deadline stops active work.
- Startup marks interrupted assignments and pauses goals without replay. Task ownership prevents
  bypassing active/paused goals. Draft goal handoff removes the old forced-delegation obligation.
- Scoped Master read_goals/draft_goal, host author attribution, Goals UI, budget/checkpoint history,
  and overall goal context in task review. ADR 0021 and docs/GOALS.md document limits.
- Full gate passed with 204 tests, lint, types and build. Browser QA passed two sequential offline
  document tasks, captured-byte inspection, human review continuation, pause/restart retention and
  final acceptance while paused. No new run on final acceptance; 2/3 attempts used. No browser errors.

## Completed checkpoint: bounded conversation context and retrieval

- Recent context is bounded to 48,000 characters with explicit omissions, retaining pinned intent
  separately. Canonical JSONL and full Markdown exports remain complete.
- Thread-scoped read_history and HTTP search/pagination return stable IDs, bounded pages and complete
  Unicode-safe message chunks. Custom HTTP requests stop before 240,000 text characters including
  schemas and accumulated tool output; no claim of token or currency accounting.
- Full gate passed at 21:47 UTC: 214 tests, lint, types and production build. ADR 0022 and
  docs/CONVERSATION-CONTEXT.md document CLI bridge, indexing and exact-context-ledger limits.

## Completed checkpoint: reviewed revision inputs

- Host-selected prior submission/review/contract provenance; bounded hash verification and input
  copies for revised documents/designs. Failed retries and restart preserve the reviewed source;
  changed requirements do not silently reuse it. Process UI links the exact prior captured files.
- Acceptance uses the same bounded file-descriptor checks. Targeted tests cover linked, changed and
  oversized evidence, failed revision/restart, changed scope, and visible provenance.
- Removed OpenCode's automatic full-transcript attachment so bounded context applies consistently.
- Full gate passed with 219 tests, lint, types and build. Browser flow passed: first offline submission,
  changes requested, second run with source inputs, inspect original 80-byte and revised 146-byte
  artifacts, record criterion evidence and accept. Original bytes remained unchanged; no browser errors.
- ADR 0023 records repository replay and OS isolation limits.

## Completed checkpoint: brief-to-task handoff

- Draft task from a saved brief opens an editable prefilled form and retains the complete source
  snapshot in the task/assignment contract. Source revisions are validated under the store lock.
- Unsaved/stale UI scope cannot be handed off; later brief edits do not replace the saved task source.
  Worker context and TASK.md retain source constraints. Creating a task does not start a Worker.
- Full source details are visible in task/edit views. Task review action styles now use theme tokens.
- Full gate passed with 223 tests, lint, types and build. Browser QA passed opening the complete
  source brief, editing the task title, saving and inspecting its source revision in Taskboard;
  status remained not delegated. No browser errors. ADR 0024 records current limits.

## Completed checkpoint: execution profiles

Assignment snapshots retain configured Worker identity/harness/model/reasoning and an instruction
fingerprint. Process UI preserves attribution after profile deletion or handle reuse, labels runtime
defaults and separates configuration from actual execution/model identity. Targeted deletion/restart
and historical UI tests passed. Full gate passed with 224 tests, lint, types and build. ADR 0025 records limits.

## Completed checkpoint: attempt history

Task-scoped historical process API, admission-ordered attempt selector, original contract/source
display and read-only historical controls. Late responses cannot replace a newer selection. Tests
cover original artifacts/review, foreign-task rejection and moving between historical/latest UI.
Full gate passed with 225 tests, lint, types and build. Browser QA selected the first 80-byte
submission and its changes-requested review, then returned to the accepted 146-byte latest output.
Historical controls were read-only and no browser errors appeared. ADR 0026 records limits.

## Final acceptance work

Audit planning-vs-execution intent, move the clean worktree to a durable ignored directory in the
project, preserve the original checkout, and rerun required checks there. Record final UI evidence,
remaining gaps and a practical user-facing handoff. Minimum work deadline still applies.

## Environment and verification

- Use `PATH=/opt/homebrew/bin:$PATH` to select Node 26 instead of the default Node 22.
- Dependencies installed from the existing lockfile with pnpm 11.19.0.
- `pnpm check` needs escalation in this environment: the pnpm version manager verifies registry
  signatures over the network; some existing tests also listen on loopback. Do not skip validation.
- Local direct tools work without registry access:
  `node node_modules/@biomejs/biome/bin/biome check --write src`,
  `node node_modules/typescript/bin/tsc --noEmit`,
  `node node_modules/vitest/vitest.mjs run <test file>`.
- No live provider calls in tests. Use temporary `NEXESTRA_HOME` and separate ports for UI QA.
- Repository owner's existing Git identity: nrhevu. Do not override it.

## Research

The linked course was fetched and Lecture 1 read. `web.run` is unavailable (404), but an escalated
read-only `curl` works. Saved source: `/private/tmp/nexestra-harness-lecture-01.html`.
The user's detailed L1–L14 summary is a design input. Do not repeat unverified numerical claims
as established facts. Validate important mechanisms against primary engineering sources.

## Active preview and tooling

- Preview process session: 84039; loopback port 4387. Script: `/private/tmp/nexestra-ui-preview.mts`.
- Preview data: `/private/tmp/nexestra-preview-data-octqCw`, disposable and independent of user data.
- Restart preserving preview data with NEXESTRA_PREVIEW_ROOT set to that path. No live providers.
- CUA binding `tab` (id "1", browser id "1"); session reset during QA, browser handle not currently bound. Browser is hidden.
- Source schema tooling: `PYTHONPATH=/private/tmp/nexestra-schema-validator python3` (jsonschema 4.25.1).
- Anthropic primary source read: `/private/tmp/nexestra-primary-long-running.html`. Its guidance is
  coding-focused; applying it to other domains is explicitly a design inference.
