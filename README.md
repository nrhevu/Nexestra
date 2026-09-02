# Nexestra

Control center for agentic work: turn a vague request into a clear spec, then
organise and supervise several coding harnesses (Codex, OpenCode) until the
result has been verified.

Local-first: one Node server on your machine plus a SPA in the browser. See
[`docs/PLAN.md`](docs/PLAN.md) for the full plan and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what exists today.

**Current milestone: M0 — skeleton + static UI.** All four surfaces render from
mock data served by the real server. No Master, no adapters, no orchestration
yet.

## Requirements

- Node >= 24 (developed on 24.19)
- pnpm 11 (`corepack enable` picks up the pinned `packageManager`)

## Getting started

```bash
pnpm install
pnpm dev
```

Then open **http://localhost:5173**.

`pnpm dev` runs two processes concurrently:

| Process | Port | What it does |
|---------|------|--------------|
| `@nexestra/server` (Hono + `ws` via `tsx watch`) | `127.0.0.1:4242` | `GET /api/health`, `GET /api/mock/*`, `ws://…/ws` |
| `@nexestra/web` (Vite) | `127.0.0.1:5173` | The SPA; proxies `/api` and `/ws` to 4242 |

In dev, `http://localhost:4242/` redirects any non-API request to the Vite
server, so the port from PLAN.md §1 still gets you to the UI.

Quick checks:

```bash
curl http://127.0.0.1:4242/api/health     # {"ok":true,"version":"0.0.0-m0"}
curl http://127.0.0.1:5173/api/mock/tasks # proxied through Vite
```

## Production-ish run

```bash
pnpm build     # apps/web/dist  +  apps/server/dist/index.js
pnpm start     # serves apps/web/dist from http://127.0.0.1:4242
```

In this mode the server serves `apps/web/dist` statically with an
`index.html` fallback, so client-side routes survive a reload. Everything is
still mock data until M1.

## Scripts

| Command | Effect |
|---------|--------|
| `pnpm dev` | Server (4242) + Vite (5173), both watching |
| `pnpm build` | `vite build` for the web app, esbuild bundle for the server |
| `pnpm start` | Run the built server, serving the built SPA |
| `pnpm test` | Vitest across every package |
| `pnpm lint` / `pnpm lint:fix` | Biome check (lint + format + import order) |
| `pnpm typecheck` | `tsc --noEmit` in every package |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXESTRA_PORT` | `4242` | Server port |
| `NEXESTRA_HOST` | `127.0.0.1` | Server bind address (keep it local) |
| `NEXESTRA_WEB_DEV_URL` | `http://localhost:5173` | Where dev-mode requests are redirected |
| `NEXESTRA_DEV` | unset | Set to `1` to force the redirect-to-Vite behaviour |
| `NEXESTRA_HOME` | `~/.nexestra` | Where the SQLite DB and artifacts will live (M1) |

## Layout

```
nexestra/
  apps/
    server/                 # Hono HTTP + ws WebSocket, mock API (M0)
    web/                    # React 19 SPA — the four surfaces
      src/shell/            # rail, navigation, surface frame, keyboard, palette
      src/surfaces/chat/    # 1. Workspace / Chat
      src/surfaces/board/   # 2. Task Board
      src/surfaces/editor/  # 3. Editor / Agent workspace
      src/surfaces/memory/  # 4. Memory graph
      src/settings/         # Settings route
      src/lib/              # API hooks (TanStack Query), Zustand store, formatting
  packages/
    core/                   # zod domain schemas, HarnessAdapter contract, mock data
    ui-kit/                 # terminal-like components + design tokens
    master/                 # (M2) Master agent
    orchestrator/           # (M4) dispatch / review / verify loop
    storage/                # (M1) Drizzle event store + projections
    adapters/codex/         # (M4) `codex exec --json`
    adapters/opencode/      # (M5) `opencode serve` + SSE
  docs/
  fixtures/                 # (M4) recorded harness output for contract tests
```

Workspace packages are consumed as TypeScript source (`main: ./src/index.ts`).
Vite aliases them, `tsx` transpiles them for the server in dev, and the
production server build inlines them with esbuild — so there is no library
build step to keep in sync.

## Keyboard

| Keys | Action |
|------|--------|
| `⌘1` … `⌘4` | Switch surface (Chat, Task Board, Editor, Memory Graph) |
| `⌘/` | Jump to Chat and focus the composer |
| `⌘K` | Command palette |
| `⌘,` | Settings |

## Theme

Dark by default, light available from **Settings → Appearance**. The choice is
stored in `localStorage` and applied as `data-theme` on `<html>`; every colour
is a CSS variable defined in `packages/ui-kit/src/styles.css`.
