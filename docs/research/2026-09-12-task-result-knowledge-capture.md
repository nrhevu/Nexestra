# Research: transferring completed Worker results into Knowledge

Taskboard already displays a completed Worker result and its branch review, while Knowledge capture
already has a deliberate name, handle, source preview, redaction, and provenance flow. The remaining
friction was navigation: a user had to find the generated Worker message in the source thread
before starting capture. That extra step makes useful implementation notes less likely to survive as
shared workspace knowledge.

The bounded change is to return the canonical agent message whose `runId` equals the latest
assignment ID in `GET /api/tasks/:id/process`. Taskboard renders **Save as Knowledge** only for a
completed assignment with that message. The existing capture dialog then submits the thread and
message IDs to the server, which rereads the transcript and captures redacted canonical content.

This preserves user control: the result is never promoted automatically, the assignment's rendered
`result` remains presentation-only, and missing or legacy provenance hides the shortcut. A future
workflow could capture verification output or a curated task summary separately, but that would
need a new source model and is outside this slice.
