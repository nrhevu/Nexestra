# 0021 — Slack-inspired project workspace

## Context

The original terminal-like M0 shell optimized density while the product was a
four-surface prototype. M8 reframes Nexestra as a long-lived project control
center: people move between work streams, Master conversation, task handoff,
run evidence and shared memory. The old TUI styling made all of those concepts
look like one diagnostic console and hid the primary navigation hierarchy.

## Decision

Keep the existing React routes and resizable panel topology, but give them a
Slack-inspired visual hierarchy:

- a global plum top bar with a real command-palette search control;
- a workspace rail and channel-like work-stream navigation;
- a light or dark content canvas with a separate context sidebar;
- system UI typography for planning and conversation, retaining monospace for
  code, diffs, commands and terminals;
- avatar-led Master/user messages, modern cards and a bordered composer;
- the same keyboard routes, approval visibility and desktop resizability.

Controls in the chrome must perform real actions. Search opens the command
palette, theme changes the persisted local theme, Settings navigates to the
settings route, and channel buttons use the existing typed routes.

## Consequences

- No domain, event, HTTP or WebSocket contract changes are required.
- `@nexestra/ui-kit` becomes a general product UI kit rather than a TUI-only
  component set; terminals and editor panes still use the mono tokens.
- Browser acceptance tests address surfaces as navigation buttons instead of
  visual checkbox rows.
- The desktop layout remains the primary target. Narrow screens reduce top-bar
  detail, but full mobile navigation is a known gap.

## Status

Accepted in M8. Supersedes the visual-design portion of
[0012](0012-react-vite-terminal-ui-on-port-5173.md). Implemented in
`packages/ui-kit/src/styles.css`, `apps/web/src/app.css` and
`apps/web/src/shell/`.
