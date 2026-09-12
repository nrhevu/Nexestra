# Feedback note research — 2026-09-12

The harness brief calls for tracking delivered work and reducing AI slop. A binary rating can rank
observations, but it cannot tell a future reviewer whether an answer was incomplete, unsafe, or merely
off scope. Langfuse documents user feedback as an application-level signal that can carry a value
and optional comment; Slack's canvas workflow similarly keeps human context beside durable work.

Nexestra already bounded and redacted feedback notes on the server. The browser now asks for an
optional note when a user marks an agent response as needs work, while helpful remains immediate and
clearing remains one click. This gives later Knowledge/evaluation review a reason without inventing
an automatic quality score or silently rewriting the agent response.

References:

- [Langfuse user feedback](https://langfuse.com/docs/observability/features/user-feedback)
- [Slack Canvases](https://slack.com/help/articles/14455334890259-Canvases--Take-notes-and-align-on-tasks)
