# Conversation reflow — 2026-09-09

## Research and selected idea

The preceding unread-navigation wave exposed horizontal overflow at 390 CSS pixels. This wave
keeps conversation controls usable at narrow widths and preserves the structure of rich messages.

- [MDN: min-width](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/min-width)
  explains the automatic minimum size of flex/grid items. Explicit zero minimum widths let a
  conversation title or search field share constrained space instead of expanding the shell.
- [MDN: overflow-wrap](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-wrap)
  describes `anywhere`, including its contribution to intrinsic sizing. This supports wrapping
  long prose and URLs while retaining preformatted code and two-dimensional tables/math.
- [MDN: overflow](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow)
  recommends keyboard focus, a suitable role and an accessible name for scroll containers that
  otherwise cannot be scrolled by keyboard users. Code, tables and display math now provide that
  context and visible focus outlines.

These are design applications of the sources, not a claim of accessibility certification. The
browser search gateway failed; the MDN pages were fetched and read directly. The W3C Reflow page
returned 403 and was not used as evidence.

Two subagents supplied initial chrome/content CSS in dedicated worktrees before service failures.
Root integrated and refined those files, fixed the short-height layout and added keyboard regions.
A resumed subagent implemented the long-link store fix; another reviewed the actual integration
diff and identified the search dropdown's assumption of a single-row header. The final dropdown
anchors to the complete topbar. No model/provider change was needed.

## Native acceptance

Chromium used a temporary FileStore, a local fixture runner and an isolated local origin. The
selected conversation began with 75 messages: plain history, an unbroken token, URL, wide code,
table and formula. Additional fixtures included an archive and a worker awaiting a local decision.
Widths/heights below are CSS device-metrics overrides, not measurements of a physical phone.

| Acceptance | Observed result |
| --- | --- |
| 390px baseline | Body/root were 617px wide; header actions ended at x617. |
| 320/390/680px reflow | Body/root match the viewport; controls remain inside the workspace. Both themes inspected. |
| 1272px desktop | Body/root 1272px; title/actions and history retain the desktop arrangement. |
| Local rich scrolling at 320px | ArrowRight moved code, table and math by 40px each. Each retained focus and a 2px outline; body stayed 320px. |
| Refresh failure | Error moves to a second header row. Search remains editable and results wrap in a bounded dropdown. |
| History failure and retry | Draft and the same 90-byte selected file survive failure, retry, Files, and return to latest history. |
| Saved long link | UI submitted a 260-character normalized URL with the file. Full URL and message text persisted; derived label is 255 characters ending in an ellipsis. |
| Successful retirement | Draft and selected file clear after successful confirmation; selected message count becomes 76. |
| Archive and linked history | Archive retains Restore and its read-only notice with no composer. A linked target exposes the notice and Show latest. |
| Local worker decision | Deny and Approve are each 58×27px inside the 320px viewport. Keyboard activation of Deny completes the fixture. |
| Short height | Before the short-height fix, composer bottom was y592 at 320×568. Afterwards it is y558 with a 120px transcript. At 320×480 it is y470, again with a 120px transcript. Header focus scrolls hidden history controls into view. |
| Short-screen menus | Review caught menu clipping when the outer composer scrolled. A separate inner scroll area now keeps File and agent options clickable; expanded formatting plus a file occupies a 144px scroll area at 320×480. |

The fixture's original 76 JSONL records (75 messages and one link artifact) remain byte-for-byte
unchanged, verified against SHA-256
`687f6dd75d3b63fdfd27a2e75b8665f82191174ec3b494bcb8a1b858b462b12a`.
The selected conversation adds only the explicit long-link message and its two artifacts. The
browser multipart upload uses CRLF line endings for that text; the full Markdown content and URL
match after that transport normalization. A separate conversation hosts the explicitly mentioned
fixture worker; it calls no real provider,
command or external file. Native evidence is stored under
`/var/folders/cf/kmgsw3k96vd73ryp8r6s9_9r0000gp/T/nexestra-reflow-UcVUPz/`.

The first combined test run passed 599/600 tests and exposed an immediate focus assertion after
asynchronous navigation. The targeted suite passed independently; its acceptance assertion now
waits for the focus effect instead of assuming render and effect finish together. The final
`pnpm check` passed lint, TypeScript, **600 tests in 45 files** and the production build after the
menu correction. Tests took 19.53 seconds and the Vite build 173ms. The complete log is
`/tmp/nexestra-conversation-reflow-check-final.log`. Final browser assertions passed at 320×480,
320×568, 320×844, 390×844, 680×844 and 1272×863: body width equals viewport width, composer stays
inside the viewport, and transcript height remains at least 120px. Browser warning/error logs
were empty.

The final request log contains 59 GETs and three explicit POSTs (two user messages and the fixture
decision). Four 503s were deliberately injected refresh/history failures. The fixture backend,
Vite server and browser tab were stopped after verification.

## Remaining ideas and limits

See [ADR 0043](../adr/0043-responsive-conversation-containment.md). Follow-up candidates include
physical phone/keyboard testing, responsive surface/modal work, first-unread-message positioning
and a portable workspace export with explicit inclusion rules. This wave does not claim those
features, screen-reader certification, cross-device read-state sync or support below 320px.
Automatic link indexing still applies the existing 4096-character URL bound.
