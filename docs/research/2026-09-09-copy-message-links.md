# Research: copying stable message links

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Existing behavior and selected gap

Nexestra already opens `/threads/<thread-id>?message=<message-id>`, resolves the owning workspace
and loads a bounded history page around the target. The IDs remain stable after a thread rename
or archive. Search and Needs attention already produce these links. The missing action is copying
that same URL directly from a saved message row.

Use **Copy message link** on saved user and agent messages. Keep the established route and stable
IDs; exclude unrelated current query parameters and fragments. Copying is browser view behavior
and must not append transcript records, dispatch a run or restore an archived thread.

## Primary sources and design consequences

[MDN's Clipboard.writeText documentation](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)
states that its promise resolves when the clipboard has been updated and that a denied write can
raise `NotAllowedError`. Nexestra should show success only after that promise resolves. When the
API is missing or the write fails, show the actual URL in a selectable field so manual copying
remains possible. A keyboard-usable button and visible feedback belong to the same action.

[MDN's secure-context documentation](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
describes loopback origins such as `http://127.0.0.1` as potentially trustworthy for local
development. This fits Nexestra's loopback server; clipboard availability still needs to be
detected at the point of use. The action does not require changing network binding or permissions.

Both MDN pages were fetched directly over HTTPS and read locally. The web-search tool returned
HTTP 404, and the W3C Clipboard specification request returned HTTP 403; neither failed request is
used as source evidence. These are implementation choices inferred from the platform behavior,
not claims that the sources prescribe Nexestra's interface.

## Acceptance and verification

The integrated `pnpm check` passes: **521 tests in 39 files**, lint, TypeScript and production
build. Five component tests cover deferred success, repeat activation while pending, unavailable
and rejected clipboard writes, keyboard activation, and a delayed error after focus moved
elsewhere. Two new integration tests copy and reopen an old paginated target and a renamed,
archived thread through the existing around-message history route.

Native browser QA used an isolated local server with 72 messages and a second workspace. On the
older 1–22 page, copying message 5 wrote its exact absolute URL to the clipboard and preserved the
composer draft. Reopening loaded messages 1–50 and visibly focused the target. After renaming and
archiving the thread, keyboard copying produced the same URL. Opening it from the second workspace
resolved the owning workspace, showed the renamed archived thread and retained the selected
message. The thread remained read-only.

A separate temporary browser page rendered the production component and styles while simulating
a delayed clipboard rejection. It exposed two gaps that DOM-only tests missed: a 360px message
pane squeezed the URL field to 14px, and disabling the pending button made Chromium drop keyboard
focus. Wrapping the metadata row gives the manual field a full row; its measured input width is
now 146px with a 24px action. The pending button keeps focus using `aria-disabled` and ignores
repeat activations. A rejected write selects the complete URL when focus is still on that button;
when the user has moved to the draft, the visible fallback leaves their focus and text intact.

The SHA-256 hash of the canonical 72-message transcript was identical before and after native QA.
The only mutation requests were the intentional Rename and Archive actions. Six anchored-history
requests and one foreign-thread metadata lookup were observed; no agent was invoked. The final
action was also visually checked in the light theme. The temporary denial page, browser tabs and
fixture servers were closed or removed after verification.

## Limits

- The URL addresses this local server and its data directory. It does not publish a conversation,
  transfer its content to another device or grant access to someone else's application.
- A different origin or port, missing thread, or removed local data can make an old URL unavailable.
  Existing missing-message handling remains responsible for reporting an unavailable target.
- Clipboard access depends on browser policy. Manual copying remains necessary when it is denied;
  the application does not change browser permission settings or use legacy copy commands.
