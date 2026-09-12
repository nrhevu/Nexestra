# Declarative custom surfaces research — 2026-09-12

The brief's second pillar is a workspace with surfaces that can adapt to a field-specific workflow.
DeepSeek Harness describes replaceable UI through slots and plugins, while Slack treats canvases as
workflow context attached to a project. Nexestra can take the useful part of that idea without
loading untrusted UI code from a local workspace.

The initial extension is declarative: a JSON config names a surface and cards, and each card routes
to an existing trusted surface. Labels are bounded and redacted in bootstrap responses; actions are
an allowlisted enum, so a config cannot execute commands, navigate to arbitrary URLs, or inject
markup. This makes an inference, evaluation, or release dashboard possible today while leaving
data-backed widgets and executable plug-ins for explicit future decisions.

References:

- [DeepSeek Harness web-client slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client)
- [Slack surfaces](https://docs.slack.dev/surfaces)
