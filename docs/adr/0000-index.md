# Architecture decision records

One record per decision, in the order they were made. The first twelve are the
decision table in [`../PLAN.md`](../PLAN.md) §1, written up after the fact with
the files that ended up implementing them; the rest are decisions the
implementation forced. Where a decision changed in practice, the ADR says so and
[`../PLAN.md`](../PLAN.md) §0.2 summarises the change.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-local-first-node-server-and-spa.md) | Local-first: a Node server on the user's machine plus a browser SPA | Accepted |
| [0002](0002-single-user-no-auth-loopback-only.md) | Single user, no auth, bound to loopback | Accepted |
| [0003](0003-typescript-pnpm-monorepo-consumed-as-source.md) | One TypeScript pnpm monorepo, packages consumed as source | Accepted |
| [0004](0004-sqlite-and-drizzle-under-nexestra-home.md) | SQLite + Drizzle under `~/.nexestra` | Accepted |
| [0005](0005-event-sourced-store-with-projections.md) | Event-sourced store with projections | Accepted |
| [0006](0006-embedded-numbered-migrations.md) | Numbered SQL migrations, embedded into TypeScript | Accepted |
| [0007](0007-master-on-claude-opus-5-messages-api.md) | The Master is Claude Opus 5 over the Messages API | Superseded by 0020 |
| [0008](0008-harness-adapter-abstraction.md) | Nexestra's own `HarnessAdapter` abstraction | Accepted |
| [0009](0009-drive-codex-with-exec-json.md) | Drive Codex with `codex exec --json` | Accepted |
| [0010](0010-drive-opencode-with-serve-and-sse-over-fetch.md) | Drive OpenCode with `opencode serve` + SSE, over plain `fetch` | Accepted (amends PLAN §1.9) |
| [0011](0011-one-git-worktree-per-task.md) | One git worktree per task | Accepted |
| [0012](0012-react-vite-terminal-ui-on-port-5173.md) | React 19 + Vite, terminal-like UI, dev on port 5173 | Visual design superseded by 0021 |
| [0013](0013-phase-machine-outside-the-llm.md) | The Master's phase machine lives outside the LLM | Accepted |
| [0014](0014-strict-tools-instead-of-structured-outputs.md) | Strict tool schemas instead of structured outputs | Accepted (amends PLAN §2) |
| [0015](0015-cross-review-by-a-different-harness.md) | Cross-review by a harness other than the executor | Accepted |
| [0016](0016-verification-runs-commands-not-claims.md) | Verification runs commands; the harness's final message is never evidence | Accepted |
| [0017](0017-approval-gates-and-budget-rules.md) | Approval gates and budget rules | Accepted |
| [0018](0018-fake-harness-for-dev-and-tests.md) | A fake harness adapter, and a `fake` harness id | Test-only portion retained; production use superseded by 0020 |
| [0019](0019-demo-llm-client-without-an-api-key.md) | `DemoLlmClient` when there is no API key | Superseded by 0020 |
| [0020](0020-production-master-provider-registry.md) | Production Master provider registry with no simulation fallback | Accepted |
| [0021](0021-slack-inspired-project-workspace.md) | Slack-inspired project workspace | Accepted |
