# Review queue bulk resolution research — 2026-09-12

The review queue already resolved one message at a time. A page-scoped selection action reduces
repetitive quality-loop work while retaining the existing guarded callback for each canonical message.
The browser toggles selected rows sequentially in visible order, clears selection after success, and
never reaches beyond the loaded page.
