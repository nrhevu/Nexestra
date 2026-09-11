# ADR 0048 - Load workspace archive dialogs on demand

## Status

Accepted. Integration validation is tracked in the linked research record.

## Context

The local ZIP inspector added an infrequently used dialog to the initial application module. After
ADR 0047, the production entry's static JavaScript graph totals 508,802 bytes and triggers Vite's
default chunk-size warning. Export and inspection should keep their existing explicit actions while
their code loads only when a user opens the corresponding dialog.

## Decision

- App imports a small shared wrapper. The export and inspection components use separate literal
  dynamic imports, with no prefetch or eager runtime import of either component. Vite may share
  dependencies between chunks; measurements include the full static import graph of each entry.
- Cache component functions by dialog kind, never workspace props, Files or reports. Coalesce a
  pending load for each kind, including React StrictMode's repeated effects. A successful code load
  remains reusable for the lifetime of that page.
- Give each load attempt a 15-second deadline. Remove failed or timed-out registry entries so the
  user can explicitly retry. Ignore an old attempt's late settlement when a later attempt exists.
  Native module imports cannot be aborted; closing detaches the UI from the result rather than
  claiming to cancel the browser's network request. The deadline bounds application waiting, not
  the lifetime of a browser-managed request.
- Show a focused, keyboard-trapped loading shell immediately, retaining the real dialog's title.
  Close and Escape work in loading and error states. Errors use bounded static copy and offer
  Retry loading; they never echo raw module errors or URLs. The wrapper owns focus restoration
  across the loading-shell-to-content handoff. Retry focuses Close before removing its own
  button, keeping keyboard focus inside the shell during the next attempt.
- Preserve the connected Settings opener before replacing Settings with an archive dialog. On
  final close, restore that opener or the command search field. Yield to a newly focused connected
  outside control or a replacement dialog instead of taking focus away from it.
- Key dialog state by kind and workspace. Close, unmount, retry and workspace changes invalidate
  pending UI generations. A late code load cannot reopen a closed dialog or mount content for the
  previous workspace. Pass current props only when rendering the requested component.
- Loading code starts no export, inspection Worker, file read, upload, provider invocation or
  workspace mutation. Download ZIP and Check ZIP remain separate user actions inside the loaded
  components. Closing within a workspace preserves the composer draft and selected attachments.
- Emit Vite's standard build manifest to inspect actual initial and dynamic import graphs. Keep
  normal warning limits and serve the existing generated HTML/static assets as before.

## Verification

See [research and QA record](../research/2026-09-09-deferred-workspace-archive-dialogs.md) for
loader, focus, navigation and production-browser evidence, including before/after bundle sizes.

## Limits

Retry starts a fresh application attempt, but native module caching remains browser-owned.
Evaluation failures are cached, and HTTP/module-fetch behavior can prevent recovery at the same
asset URL. A stale deployment or persistent module error can require reopening the page. There is
no automatic reload or cache-busting URL, because either would change the current page's lifetime
and could discard selected attachments. Close keeps the rest of the app available.

The first opening now waits for optional code and CSS. Entry-byte reductions do not establish a
measured startup-time improvement, and opening a conversation can separately load its rich-message
renderer. Export preparation and ZIP inspection keep their existing deadlines and memory limits.
