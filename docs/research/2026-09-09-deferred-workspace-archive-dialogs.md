# Deferred workspace archive dialogs — research and QA, 9 September 2026

## Why this idea

The archive inspection wave ended with a 508,802-byte production entry and Vite's default size
warning. Export and ZIP inspection are optional workflows. Loading their dialog code when opened
is a bounded improvement that can be measured without changing export or integrity semantics.

## Primary sources

- [React: lazy](https://react.dev/reference/react/lazy) documents that React caches both the loader
  Promise and its resolved component, and forwards a rejection to an Error Boundary. Nexestra uses
  an explicit loader registry and local wrapper state to own retry and deadline behavior.
- [MDN: import()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import)
  describes on-demand module loading and caching. Evaluation failures are cached; load/link
  failures may be retried, subject to the browser's fetching and HTTP cache behavior. Application
  retry cannot promise recovery from every native import failure.
- [Vite: Features](https://vite.dev/guide/features) explains dynamic-import dependency preloading
  and asynchronous CSS splitting. Shared chunks must be counted when comparing loading costs;
  looking only at the file named index would undercount a split entry.
- [Vite: Backend integration](https://vite.dev/guide/backend-integration) documents the build
  manifest's entry, imports, dynamicImports and CSS relationships. The measurements below traverse
  static imports recursively and count each emitted asset once.

The web tool returned a transport 404. These official pages were fetched directly over HTTPS and
read on 9 September 2026. The timeout, retry UI, cache ownership and workspace guards are Nexestra
design decisions, informed by those APIs rather than prescribed by the sources.

## Implementation

Three subagents implemented the loader/wrapper, loading/error shell and App navigation acceptance
tests in dedicated worktrees. Root integrated the changes, reviewed lifecycle behavior, recorded
bundle evidence and verified the real production assets with controlled delayed/failed requests.
The contract is in [ADR 0048](../adr/0048-deferred-workspace-archive-dialogs.md).

## Verification record

- `pnpm check` passes on the integrated source with Node 26 and
  `NODE_OPTIONS=--no-experimental-webstorage`: Biome checks 135 files, TypeScript passes,
  **830 tests in 59 files** pass, and both client and server builds finish. There are 40 added
  acceptance cases over the 790-test archive-inspection baseline. No provider or credentials are
  required by these tests, and there are no temporary component/loader stubs in the integration.
  One intermediate full-suite run exposed an existing surface-refresh test's wall-clock race
  against the 400 ms focus debounce. That case now advances the debounce with controlled timers,
  retaining the exact two-bootstrap/no-unrelated-history assertions; the final full gate passes.
- The 29 loader, wrapper and shell cases cover inert module registration, kind selection, pending
  coalescing, ready component caching, bounded failures, timeout/retry, late settlement, StrictMode,
  current props, workspace/kind changes, focus handoff, keyboard trapping and listener cleanup.
  Late module settlement cannot replace the active retry or mount a closed dialog.
- The App suite has 124 passing cases, including 11 new acceptance cases. It verifies inert
  bootstrap/navigation, draft and attachment preservation, pending workspace transitions, retry,
  same-workspace Back and command navigation, and Settings-opener restoration for both dialogs in
  pending and ready states. Existing actual export and inspection actions remain covered.

### Production bundle measurements

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Entry's static JavaScript graph | 508,802 bytes | 495,008 bytes | −13,794 bytes (−2.71%) |
| Entry's CSS | 98,890 bytes | 95,828 bytes | −3,062 bytes (−3.10%) |
| Separate inspection Worker | 107,395 bytes | 107,395 bytes | unchanged |

After bootstrap, the first explicit opening adds the following assets beyond the initial graph:

| Dialog | JavaScript | CSS |
| --- | ---: | ---: |
| Export workspace | 7,280 bytes | 747 bytes |
| Inspect workspace ZIP | 12,336 bytes | 3,271 bytes |

The baseline is commit f7b2aeeb with the unused dialog contract and standard manifest emission
enabled. Its entry is index-S1Hx-jCi.js. The final entry is index--q9eACTO.js (486,451 bytes), with
jsx-runtime-B-hcVAMW.js (8,557 bytes) in its static import closure. Both are counted. The two
archive dialogs are dynamic entries in `.vite/manifest.json`, are dynamically reachable from the
entry and are absent from its recursive static import closure. No warning threshold or manual
chunk-size exception was added; the final build emits no chunk-size warning.

To reproduce the measurement, run `pnpm build`, read `dist/web/.vite/manifest.json`, traverse
`imports` from `index.html` with a visited set, and sum each resulting `file` and `css` asset once.
For a dialog, traverse its source record and subtract the initial sets. Do not include
`dynamicImports` in the initial closure. These are raw emitted bytes; the current Hono server does
not add gzip middleware. A conversation can separately request RichMessage after bootstrap, so
that renderer is outside this static-entry metric. Loading both archive dialogs eventually adds
their code plus the new loading UI/registry overhead. This is a reduction in initial loading, not a
claim of smaller total application code, measured startup speed or lower memory use.

### Native production checks

QA serves real production assets through Hono with an isolated FileStore and a runner that counts
and rejects provider invocations. Only the temporary QA server delays or returns 503 for selected
dialog assets; application code, browser imports and archive Workers are real. Controlled failures
use `Cache-Control: no-store`. Final controlled dialog responses also use no-store so fresh page
loads can repeat the scenarios without an HTTP cache hiding the delay.

- Opening Agents, switching to Threads and opening Settings requests no archive-dialog chunk,
  export endpoint or inspection Worker. Opening a dialog then requests only its own code/CSS;
  ordinary conversation rendering loads RichMessage independently.
- With the export asset delayed 9 seconds, loading Close has focus and Tab remains inside the
  shell. Escape closes it, retains the draft and a real 52-byte selected attachment, and the late
  HTTP 200 does not reopen it. Reopening uses the already loaded component and still starts no
  export. The final build repeats pending/ready close through Settings and restores Open settings
  correctly; the removed Settings action had caused a real focus bug before this fix.
- A real inspector asset 503 shows the bounded error. After the server recovers, Retry in that
  same page still fails without a second HTTP request: this browser retains the failed module
  load despite no-store. Close preserves the draft/attachment and restores command-search focus.
  Reopening the page allows a new request. The final error hint therefore explains page reopening
  and that message attachments need to be selected again; no automatic reload is performed.
- A 19-second inspector response reaches the 15-second UI deadline. Even after HTTP 200 arrives,
  the timeout remains visible and Check ZIP is absent. Explicit Retry then opens the inspector.
  Selecting an actual 36,322-byte ZIP creates no Worker. Check ZIP requests the real 107,395-byte
  Worker and reports eight verified payloads totaling 32,094 bytes.
- In the final build, Browser Back during a delayed inspector load returns from the second
  workspace to the first and immediately removes the dialog. A late response cannot reopen the
  old workspace's dialog. The loading shell is visible and usable at 320×480 in the light theme.
- Native Retry initially removed its focused button and left focus on the page body. A regression
  assertion reproduced that failure; the shell now focuses Close before beginning the retry.
  The short mobile error layout keeps the recovery guidance, Retry and Close within the viewport.

The native tests include controlled asset errors, and the initial page requests an existing missing
favicon (404). These are not described as a clean browser-error log. Production UI checks do not
claim to cover every browser's module-cache or focus behavior.

Final server proof reports **0 provider invocations** and unchanged SHA-256 hashes for all seven
original source files. Request logs show no non-GET requests or automatic workspace export. The
Worker appears only after the explicit Check ZIP action. Light/dark checks covered 320×480,
390×844 and 1280×900; the final short-screen error dialog is 300×265 pixels inside a 320-pixel
page, with Close and Retry available. Native Retry now keeps focus on Close, and a fresh ZIP
inspection in the final build again verifies all eight payloads.

## Known limits

Native import requests continue after a UI timeout or close. Old results must be ignored by that
UI, while a successfully loaded component can still be reused by another explicit opening.
Browser-owned module caching can retain errors; an explicit retry is not a universal stale-asset
recovery mechanism. The app performs no automatic reload. Export and inspection retain the limits
in ADRs 0046 and 0047, including no import/restore support.
