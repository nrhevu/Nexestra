# Needs-work review queue research — 2026-09-12

The brief calls for a Knowledge path that cuts AI slop through deliberate human review. Current
feedback already records a bounded note and exact message/run provenance, while message capture
requires an explicit preview. The missing step was finding those needs-work replies again across a
workspace.

DeepSeek Harness presents orchestration as traceable workflow events, and Slack describes canvases
as a place where project workflow documentation stays attached to the working context. Nexestra
adopts the smaller local-first equivalent: a cursor-paged inbox that links back to the canonical
message and leaves promotion or correction to the user.

The first slice is deliberately read-only. It deduplicates to the newest negative rating per
message, caps excerpts at 800 characters, redacts known credentials, and reports unavailable
transcripts. Resolution state and evaluation-case export remain separate follow-up decisions.

References:

- [DeepSeek Harness workflow events](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md)
- [Slack project workflow guidance](https://slack.com/blog/productivity/how-to-build-a-project-management-workflow-that-works)
