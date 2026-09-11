# Unread conversation navigation - research and verification

Date: 2026-09-09. Scope: extend browser-local unread state with filtering and explicit navigation.

## Research and selected ideas

Primary sources fetched and read directly over HTTPS:

- [MDN: aria-pressed](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-pressed)
  explains toggle states and recommends keeping the label stable as pressed state changes. Applied
  as native All/Unread buttons with stable accessible names and `aria-pressed`.
- [MDN: input type=file](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)
  describes selected files as a FileList of File objects. A script cannot set the picker value to
  a local path. This supports retaining actual objects during in-app navigation and selecting them
  again after reload; storing a filename does not recover the bytes.

The web search tool returned a fatal 404. Direct Slack unread-navigation and W3C button-pattern
requests returned 403; neither page was used. These decisions combine accessible controls guidance
with inspection of Nexestra's actual sidebar, routes and read state. They are product design
judgments, not claims that another application implements this exact workflow.

| Idea | Decision and reason |
| --- | --- |
| All/Unread filter | Implement. Remove read rows from long lists without changing the conversation being read. |
| Next unread conversation | Implement. Reuse the command palette and include archived unread consistently with the total. |
| Keep the current row after acknowledgement | Implement. Preserve context and the focusable row during filter updates. |
| Keep selected files while navigating | Implement. File state previously belonged to the mounted ThreadView, so navigation could discard an unsent attachment. |
| Persist the filter after restart | Defer. Open with All after reload; saved read markers preserve the underlying state. |
| First-unread-message anchor | Defer. The marker is a count rather than a validated message cursor; open the latest bounded page. |

## Resulting behavior

The filter badge counts conversations; row/Threads badges count messages. Unread includes archived
conversations and pins the current row when read. With zero unread, the list explains that exception.
All restores the ordinary list. Filters stay per workspace in this tab and reset to All on reload.

Next scans after the current conversation in active-then-archived order and wraps. It resolves from
current read markers, including a storage event arriving while the command is open. From a surface
it opens the first unread in that workspace. If only the current conversation is unread, it opens
latest Messages from Files, linked/older history or a scrolled-up latest page. Repeated clicks share
an in-flight latest request and do not push duplicate bare URLs. With none, a short status appears
without a request; the sidebar button is disabled.

App-owned File objects survive routes and workspace switches. Confirmation retires only captured
objects, preserving new selections and other workspaces. Existing recovery semantics distinguish
in-session edits from reconstructing an unconfirmed attachment send after reload. Bytes never enter
localStorage. No read/navigation action invokes an agent or writes canonical history.

## Implementation and review

Two subagents implemented the pure `unreadNavigation` model and the independent
`ConversationFilterControls`/TopBar command in dedicated worktrees. Integration adds App-owned
filters and file buckets, latest-page routing, and current-row retention. The narrow sidebar now
uses its existing theme background token so light text and controls share a readable background.
Native QA also exposed inherited `flex-direction: column` placing mobile navigation outside the
50px strip. An explicit row direction now keeps controls aligned in that strip.

Review found that reusing a send's scroll signal to open Messages could pull a user out of Files
when an in-flight send completed. The explicit Messages signal is now separate, with a delayed-send
test. The pagination fixture's optional second thread was corrected to belong to the selected
workspace; its next-thread test now follows the same scope contract enforced by the real server.

The final send review also covered an older response arriving after a remount and a newer payload
that reused the same File objects. Attachment retirement now requires the matching pending request;
the older success leaves the newer payload's files available for its exact retry.

## Verification

The final `pnpm check` passed lint, TypeScript, **596 tests in 45 files**, and the production build,
with no live providers or credentials. Tests took 16.97 seconds and the Vite build 179ms on this host.
The complete log is `/tmp/nexestra-unread-navigation-check-final.log`. Delayed send/retry races are
covered by deterministic acceptance tests; native evidence below covers navigation and rendering.

Native Chromium used a temporary FileStore and a local fixture runner, with 28 conversations,
70 original messages in the selected conversation, archived history and a second workspace.

| Check | Observed result |
| --- | --- |
| Local filter | 28 rows became 3 unread rows. Request count stayed 13 before/after filtering. |
| Next ordering | Selected → External work → Archived reading → selected; archive remained read-only with Restore visible. |
| Current-row retention | Acknowledged rows stayed while selected; zero unread explained the retained current conversation. |
| Draft and selected bytes | The original draft and 87-byte file survived the unread cycle and workspace switches. |
| Only-current command | At 680px, `/next unread` opened Messages from Files and acknowledged 74 after loading; browser history length stayed 7. |
| Workspace filter | Other workspace opened with All; returning restored Unread, draft and selected file. |
| Empty command | At 390px, no navigation and request count stayed 37 before/after; draft/file retained. |
| Reload | All and 28 rows returned; draft text and read markers remained, selected bytes were gone as documented. |
| Responsive controls | At 680px, the filter occupied x452–618, y45.5–91.5 within the x58–680, y44–94 sidebar. Pointer and keyboard both toggled it. At 390px keyboard focus scrolled the sidebar to the filter. |
| Visual and browser QA | Both themes inspected; All/Unread targets 24px high, Next 26×26. Count badge contrast: dark 8.80:1, light 5.36:1. No browser warnings/errors. |
| Durability | All original 70 JSONL records remained byte-identical; selected transcript ended at 74 explicit fixture notes. No fixture runner invocation or unexpected mutation path. |

Evidence directory: `/var/folders/cf/kmgsw3k96vd73ryp8r6s9_9r0000gp/T/nexestra-unread-navigation-ApUL8F`.
It contains `browser-proof.json` (14 states, 3 style checks), `integrity-proof.json`, request logs and
before/after request snapshots. Original-prefix SHA-256:
`38549f5c7d04a9d352acc4a78a536eb09d76a0c2dfbe446d759844f51015c9dc`.
The run recorded 42 HTTP requests, including nine explicit fixture mutation requests, and zero
provider/fixture invocations. These local temporary artifacts are not source fixtures or shipped data.
The native tab and both local fixture servers were stopped after verification.

Responsive sizes were Chromium device-metrics overrides, not physical OS window sizes. Layout was
checked from CSS geometry. At 390px, existing conversation content still measured 614px wide; the
new controls and command work there, but full phone layout remains an honest follow-up gap. Native
evidence does not claim a new screen-reader audit, cross-device sync or live-provider evaluation.

## Known limits

See the [ADR](../adr/0042-unread-conversation-navigation.md) for the full decision. Filters and
selected bytes are tab-local; only draft text and read markers survive reload. Many drafts can keep
several composer-sized file buckets. Next uses known metadata without idle polling or a cross-workspace
inbox and does not locate the first unread message. Current-row retention is an intentional filter
exception. Narrow navigation remains a scrollable strip, with a command palette alternative.
