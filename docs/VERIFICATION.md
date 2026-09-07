# Workspace/harness verification record

This record describes evidence from the dedicated development branch. Tests and browser fixtures
do not call live Codex, OpenCode or remote models, and do not establish real-provider output quality.

## Automated acceptance

The complete `pnpm check` gate passed with **228 tests across 25 files**, including lint, TypeScript
and a production build, at 2026-09-06 22:49 UTC in the durable worktree.
Final status is recorded in `PROGRESS.md`.

The suite covers these behavior boundaries:

- Brief revisions, source snapshots, stale writes, thread/workspace scope and known-secret redaction.
- Workspace creation publishes metadata only after a successful write; failure leaves both memory
  and disk unchanged and a later attempt can succeed.
- Bounded conversation packing without changing canonical bytes, scoped search/pages, Unicode-safe
  message chunks, and stopping oversized text before a custom-provider request.
- Draft plans that finish without forced delegation, execute-mode completion obligations and
  draft-goal handoff, for both supported HTTP provider protocols.
- Serial Worker queues, non-Git directories and Git transports, cancellation, failures and startup
  interruption. Default tests use process/HTTP fixtures, not live credentials.
- Frozen criteria, independent human acceptance, missing/stale evidence, captured output hashes,
  symlinks/hardlinks, byte limits, modified files, revision inputs and closed accepted review chains.
- Configured execution provenance through profile deletion, handle reuse and restart; task-scoped
  attempt inspection with original output/review and read-only historical UI.
- Goals with frozen scope, attempt/time budgets, one active goal per workspace, pause/cancel,
  restart without replay, review continuation and terminal-state protections.
- Declarative table/board/canvas/document manifests, typed records, revision conflicts, enabled
  state, workspace/author controls, import/export and human/tool command parity.

## Browser acceptance

The local preview uses a separate temporary data directory and an explicit offline runner.
Interactive checks passed on production assets, including dark and light themes:

- Create/save/confirm a brief, preserve local edits on conflict, navigate to its conversation,
  draft an editable task and inspect the complete source scope without starting execution.
- Start a document Worker, inspect captured file bytes and accept only after recording evidence.
- Run two sequential goal tasks, review the first to continue, pause while the second waits,
  restart, and accept the final result without another run. The goal retained 2/3 attempts.
- Request changes on an 80-byte offline document, produce a 146-byte revision that confirms it
  read the prior 80-byte input, inspect both stored files and record an acceptance observation.
- Select the first attempt's file and changes-requested review, then return to the accepted latest
  attempt. Historical mutation/launch/new-review controls were absent.
- After moving the worktree, run a fresh offline task, inspect its runtime-default profile and
  instruction fingerprint, read the captured 80-byte document and accept its explicit offline criterion.
- Create a Vietnamese canvas note, edit position/content, save/reload, copy selected semantic
  context, archive/restore and enable/disable the surface.

No browser warning/error entries were reported during these acceptance flows. Mermaid sources
passed canonical-schema validation and static lint; no image-renderer acceptance is claimed.

## Practical limits

Human review is the implemented evaluator. The app does not yet certify arbitrary output quality,
effective remote model identity, exact replay, OS isolation, token spend or graph coordination.
The single-user store assumes one server owner per data directory. See `ARCHITECTURE.md`, the
ADR index and `ROADMAP.md` for the complete boundary rather than inferring guarantees from test count.
