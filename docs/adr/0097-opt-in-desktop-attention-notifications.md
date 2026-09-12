# ADR 0097: Offer opt-in desktop Attention notifications

Status: Accepted

## Context

Attention is useful while a user is supervising work in another tab, but polling or server-side
notifications would add background work and a new delivery boundary. The browser already receives
bounded cross-workspace attention counts.

## Decision

Settings exposes an opt-in browser notification toggle. The browser requests permission only after
the user presses the enable control. Existing activity-summary refreshes compare each workspace's
current count with the last observed count and create one generic notification only when that count
increases. The body contains the workspace name and count; it never contains titles, details,
prompts, transcripts, provider data, or credentials. Duplicate refreshes are coalesced by the
in-memory per-workspace count map. The preference is browser-local and storage failures or denied
permissions leave the application usable.

## Consequences

Notifications are best-effort and limited to a browser profile. They do not create server history,
change Attention filtering, or notify when counts fall. A new tab establishes its own baseline and
does not replay old alerts.
