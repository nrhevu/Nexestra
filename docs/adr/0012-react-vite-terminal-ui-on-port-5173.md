# 0012 — React 19 + Vite, terminal-like UI, dev on port 5173

## Context

The UI was specified from a wireframe: monospace, dense, box-drawn borders,
dark-first — a TUI rendered as real DOM rather than ASCII. PLAN.md §1.1 also
said the user opens `http://localhost:4242`, the server's port.

## Decision

React 19 + Vite + TanStack Router/Query + Zustand, with a `@nexestra/ui-kit`
package holding the components and the CSS-variable design tokens.

In development the SPA is served by **Vite on `127.0.0.1:5173`**, which proxies
`/api` and `/ws` to the server on `4242`. The server, in dev mode, redirects any
non-`/api` request to `NEXESTRA_WEB_DEV_URL`, so `4242` still gets you to the
UI. A production `pnpm build` + `pnpm start` serves `apps/web/dist` from `4242`
with an `index.html` fallback, and there is only one port.

## Consequences

- HMR works, which it would not behind the Node server.
- Two ports in dev, one in production — the redirect keeps the documented URL
  honest in both.
- Every colour is a CSS variable in `packages/ui-kit/src/styles.css`, applied as
  `data-theme` on `<html>`, so light mode is a token swap.
- The web bundle is still one large chunk; code-splitting per surface is
  deferred (`docs/ARCHITECTURE.md` §11).

## Status

Accepted; amends PLAN.md §1.1 on the dev URL. Implemented in
`apps/web/vite.config.ts`, `apps/server/src/config.ts` (`WEB_DEV_URL`,
`DEV_MODE`), `apps/server/src/app.ts`, `apps/server/src/static.ts`,
`packages/ui-kit/src/styles.css`. PLAN.md §1.11, §7.
