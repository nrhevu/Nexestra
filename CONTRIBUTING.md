# Contributing

## Development loop

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Use `NEXESTRA_HOME=/tmp/nexestra-dev` when testing mutations to avoid touching real data.
Use a separate port pair when running multiple worktrees.

## Change discipline

- Start with the contracts in `src/shared/contracts.ts`; do not duplicate types in the UI or server.
- Keep transcripts append-only. Repair projections by replaying events, not by rewriting chat history.
- Secrets pass only through `credentials.json` and direct requests to the selected provider.
- Inject a fake `AgentRunner` in tests; do not require CLI login or paid requests.
- Make the smallest change that satisfies the criterion; do not add speculative frameworks or abstractions.

## Commit

Use conventional commits and the repository owner's configured Git identity. Do not replace it
with a bot or project identity.
