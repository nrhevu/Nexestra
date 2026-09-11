# Research: workspace attention and direct navigation

Research date: 8 September 2026 (Asia/Ho_Chi_Minh).

## Sources and observations

1. [Linear Inbox](https://linear.app/docs/inbox) collects updates that need attention, offers a
   priority view, supports keyboard navigation, and opens the related issue from a notification.
   This suggests a useful pattern for Nexestra: make pending decisions visible across threads and
   provide a direct route to the existing controls.
2. [Linear AI Agents](https://linear.app/docs/agents-in-linear) keeps delegated work visible to the
   human owner. Nexestra already has delegation and process history; a workspace view can connect
   that history to the next action the user needs to take.
3. The [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) specifies arrow-key
   navigation, Enter acceptance, Escape dismissal, and focus/selection semantics. The
   [official source](https://github.com/w3c/aria-practices/blob/main/content/patterns/combobox/combobox-pattern.html)
   was consulted for keyboard behavior and `aria-activedescendant` guidance.

These are product-design inputs, not evidence that the proposed changes will improve measured
user outcomes. No usability study was performed.

## Repository findings

The starting point is `c5f1233` on `codex/task-verification-contract`, which already contains
external verification, assignment retries, manual delegation, assignment history, and explicit
worktree/merged-branch cleanup. The main checkout also already has draft storage, global search,
a command menu, and live thread events. Rebuilding those features would duplicate existing work.

Three gaps remain:

| Gap | Proposed change | Decision |
| --- | --- | --- |
| Pending questions or approvals in another thread can remain hidden while the selected thread runs. Nonempty activity responses are discarded. | Workspace **Needs attention**, per-thread run badges, and activity refresh that also observes other running threads. | Implement now. |
| Search supports focus by shortcut but lacks keyboard result selection; task and knowledge hits open only the containing surface. | An accessible search combobox with direct task and knowledge detail navigation. | Implement now. |
| Leaving a conversation for a surface or another workspace can lose the last visited thread. | Remember the last visited thread per workspace and expose saved drafts in navigation. | Follow-up candidate; not part of this change. |

## Selected behavior

**Needs attention** shows current requests for approval or input and tasks that are blocked or
whose latest assignment failed or was interrupted. An item opens its thread or task process
dialog so the user can use the existing action controls. Merely viewing an item does not approve
tools, invoke agents, or retry assignments. Resolved conditions disappear from the projection;
historical failures do not survive a newer active or successful assignment.

The projection uses existing workspace metadata and active-run state. It introduces no transcript
copy, new stored queue, notification subscription, or migration. Active-only refresh continues to
avoid idle polling, while selected-thread streaming and other active threads can be observed at
the same time. Workspace changes must discard delayed results from the previous workspace.

**Search** keeps the current local data and Cmd/Ctrl+K entry point. Arrow keys select results,
Enter opens the selected record or executes a command, and Escape closes the results. Task and
knowledge results open their exact existing detail dialogs. The browser focus remains in the
search input while navigating suggestions.

## Acceptance and limits

Verification covers workspace isolation, resolving waiting states, latest-assignment selection,
background transitions while another thread streams, completion while other work remains,
idle request behavior, keyboard selection, and opening the matched record. Default tests use fake
runners and require no provider credentials. The repository-wide handoff gate is `pnpm check`.

The view is a current-state work list: it has no read/unread history, snoozing, dismissal, desktop
notifications, or monitoring across workspaces. Ordinary failed chat runs are not retained in
this view; they remain visible and retryable in their thread. Detecting work started in another
browser while this browser is completely idle remains outside the refresh contract.

## Verification results

`pnpm check` passed: lint, TypeScript, 172 tests across 15 files, and the production build.
The host used Node 26.0.0 and pnpm 11.19.0, with the command-scoped
`NODE_OPTIONS=--no-experimental-webstorage` flag so Node's experimental Web Storage globals do not
interfere with jsdom. No package scripts or user-wide runtime settings were changed.

Browser checks used a disposable local data directory and a fake runner. The desktop layout,
exact task/knowledge search targets, pending-question navigation, resolution while another agent
continued running, and the empty attention view after switching workspaces were verified. The
startup recovery regression was also reproduced with a replaced data directory and verified after
the fix.
