# ADR 0043 - Responsive conversation containment

## Status

Accepted.

## Context

ADR 0042 recorded horizontal overflow at phone widths. A long conversation title and the
non-wrapping action cluster made a 390px viewport contain 617px of content. Rich content also
needs deliberate two-dimensional scrolling, and the initial long-URL fixture could not be saved
because its derived artifact name exceeded 255 characters.

## Decision

- Keep conversation layout rules in `ConversationChrome.css` and `ConversationContent.css`, loaded
  after the base stylesheet. At the existing 720px breakpoint, permit header actions, notices,
  tabs and file filters to wrap; give text-bearing flex/grid items an explicit zero minimum width.
- Arrange history controls as a two-column grid, preserving keyboard order and all action labels.
  Keep the range and loading/error states visible. The horizontal workspace navigation strip keeps
  its existing behavior.
- Group the title, actions, tabs and history in `thread-chrome`. On mobile viewports at most 700px
  high, allow that group to scroll vertically, retain at least 120px for the transcript, and bound
  the composer content to 30dvh with its own scrolling. Menus sit outside that scroll container
  so their floating panels remain visible. Header controls remain reachable by keyboard focus;
  the transcript retains its existing scroll container and latest-bottom observation.
- Allow the mobile topbar to grow a second row for refresh errors. Search suggestions use the
  topbar as their positioning ancestor so they appear below either header height and remain
  bounded by the viewport.
- Wrap ordinary prose and URLs. Preserve code whitespace, table structure and display math inside
  local horizontal scroll containers. Give those containers accessible names, keyboard focus and
  visible focus outlines. Keep the code-copy action visible on touch layouts and keyboard focus.
- Use existing theme tokens for rich headings, emphasis, quotes, table headers and file inventory
  text/backgrounds that previously used dark-theme constants.
- Bound only the derived link artifact display name to 255 characters, with an ellipsis for long
  names. Keep the complete normalized URL as artifact identity and retain original message text.
  Short labels, deduplication, receipt replay and canonical append behavior remain unchanged.

## Verification

Store acceptance covers long/short URL labels, distinct/repeated URLs and receipt replay after
reopen. Rich-message acceptance covers named, focusable code/table/math regions while retaining
code whitespace and table/MathML structure. An existing navigation assertion now waits for the
asynchronous focus effect after returning from Files.

The [research and QA record](../research/2026-09-09-conversation-reflow.md) documents browser
geometry, keyboard scrolling, short viewport behavior, long-URL HTTP persistence and the final gate.
The final gate passes lint, TypeScript, 600 tests in 45 files and the production build.

## Limits

This is conversation reflow, not a full responsive redesign of every surface/modal. The supported
CSS minimum remains 320px. Short screens use multiple explicit scroll areas; physical touch devices,
software keyboards, Safari, Firefox and assistive-technology output still need separate validation.
The existing 4096-character artifact URL limit remains. Existing transcripts are not migrated to
different display labels. Rich-content regions are keyboard stops even when their contents fit.
