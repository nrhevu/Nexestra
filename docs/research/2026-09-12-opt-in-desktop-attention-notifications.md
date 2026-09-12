# Opt-in desktop Attention notifications research

The harness brief asks for supervision across heterogeneous agents. The app already polls bounded
workspace activity summaries while work is active, so a browser-only count increase signal can cover
the common “working in another tab” case without adding a server notification queue.

The implementation stores only an enabled flag in browser local storage. Permission is requested on
the explicit Settings action, never on bootstrap or passive polling. Each workspace has an in-memory
last-seen attention count; only a strict increase produces a generic notification containing the
workspace name and count. Missing storage, unavailable Notification APIs, denied permission, and
duplicate refreshes are safe no-ops.

This is deliberately not a delivery guarantee or audit mechanism. It does not persist notification
events, replay old counts, include alert content, or synchronize preferences across browsers.
