# Reviewed Knowledge capture research — 2026-09-12

The product brief asks Nexestra to turn useful agent work into durable Knowledge while reducing AI
slop. The existing server already stores a captured message as an immutable, redacted document with
thread and message provenance, but the browser previously submitted generated metadata immediately.

DeepSeek Harness treats the workspace and session context as explicit resources, while Slack Canvas
describes a user-owned surface for notes, links, and tasks. Both patterns suggest that a durable
workspace artifact should have a visible boundary where the user can inspect and name what is being
kept. Nexestra now puts that boundary in front of `from-message`: the dialog previews the exact
source, accepts a user-chosen name, handle, and description, and submits only after confirmation.

The content remains unchanged and server-redacted. This keeps capture auditable and avoids implying
that the harness has judged an answer merely because it was saved. A later correction queue can let
the user edit a needs-work reply into a reviewed artifact or evaluation case; that should remain a
separate, explicit workflow.

References:

- [DeepSeek Harness workspace subsystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace)
- [Slack Canvases](https://slack.com/help/articles/14455334890259-Canvases--Take-notes-and-align-on-tasks)
