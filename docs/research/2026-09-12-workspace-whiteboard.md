# Workspace whiteboard research — 2026-09-12

The brief calls for a workspace with surfaces that help users debate, plan, and transfer durable
work. A whiteboard is a useful first surface because it supports free-form planning without adding
another agent protocol or a domain-specific schema. DeepSeek Harness and Slack both keep the user
interaction surface composable; Nexestra can apply the same idea locally while keeping each surface
bounded and explicit.

The implementation uses a single per-workspace Markdown file rather than browser storage or an
unbounded document collection. This keeps recovery simple and gives the user a durable place for a
decision log. A 64 KiB UTF-8 limit, atomic mode-0600 writes, and credential redaction keep the
surface aligned with Nexestra's existing local-first and secret-handling rules. The editor saves
explicitly and does not dispatch work or execute Markdown. Future work can add export and a
deliberate opt-in path for promoting selected notes into Knowledge.

References: [DeepSeek Harness web-client surfaces](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client),
[Slack surfaces](https://docs.slack.dev/surfaces).
