# AGENTS.md — Nexestra M9

Nexestra is a single-user, local-first application: one Node/Hono server, one React/Vite SPA, and
JSON/JSONL files under `.nexestra/`.

## Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Node >= 24, pnpm 11. Tests must pass without Codex, OpenCode, or credentials.
Do not call live providers in default tests.

## Map

- `src/shared/contracts.ts`: shared types and Zod schemas.
- `src/server/store.ts`: state metadata, secret storage, and append-only transcripts.
- `src/server/dispatcher.ts`: `@mention` rules, per-agent queues, and retries.
- `src/server/runtime.ts`: Codex, OpenCode, and custom-provider transports.
- `src/server/auth.ts`: ChatGPT device login owned by Codex CLI.
- `src/server/app.ts`: HTTP API and loopback-origin guard.
- `src/web/`: SPA and visual system.
- `src/shared/work-brief.ts`: bounded work brief context shared by every runtime.
- `src/shared/conversation-context.ts`: recent context packing, history retrieval and request size bounds.
- `src/shared/goals.ts` and `src/server/goal-controller.ts`: goal policy, budgets and review-driven continuation.
- `src/shared/surfaces.ts`: declarative extension and semantic context contracts.
- `src/web/surfaces/`: Work Briefs, Goals, task review, and declarative table/board/canvas/document views.
- `docs/HARNESS-DESIGN.md`: target design; `docs/ARCHITECTURE.md`: implemented behavior.
- `PROGRESS.md` and `DECISIONS.md`: current work and pointers for fresh sessions.

## Rules

1. Persist each user message before dispatch. Do not invoke an agent without a mention.
2. Each thread has exactly one canonical JSONL transcript. Every agent writes replies to that file.
3. API keys and OAuth tokens must never appear in transcripts, `state.json`, responses, or logs.
4. ChatGPT OAuth belongs to Codex CLI. Never read `auth.json` directly or store access/refresh tokens.
5. Harness processes close stdin, enforce timeouts and output limits, and receive only allowlisted environment variables.
6. Agent replies do not trigger new mentions. One agent works serially; different agents may run in parallel.
7. Keep the server on loopback and validate Origin for mutations. Do not expose a bind address without authentication.
8. Protocol parser changes require corresponding fixtures and tests. Unknown or malformed stream lines must not crash the parser.
9. Every behavior change requires the smallest test that proves its acceptance criterion; run `pnpm check` before handoff.
10. Documentation is part of the same change. Every new architecture decision requires an ADR and an honest record of known gaps.

Work on a dedicated branch and worktree. Use a conventional commit subject and the repository
owner's configured Git identity; do not replace it with a bot or project identity.
