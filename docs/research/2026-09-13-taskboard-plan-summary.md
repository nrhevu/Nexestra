# Taskboard plan summary research — 2026-09-13

The current harness persists Master-created plan identity on Tasks and persists thread plan mode,
but it does not pause a plan for approval. A small, useful next step is therefore a read-only
progress surface that makes the existing identity visible after refresh and export.

DeepSeek Harness documents a replayable `plan/mode` event alongside (rather than inside) the model
transcript, which supports Nexestra's durable plan-mode event design: [plan subsystem
documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md).
Codeg's release direction shows plan cards and explicit approval, request-changes, and abandon
concepts, suggesting approval is valuable but requires a pending-plan lifecycle: [Codeg
releases](https://github.com/xintaofei/codeg/releases).

Nexestra should first group the `planId`/`planTitle` already on selected-workspace tasks and show
bounded counts for ready, delegated, queued, running, blocked, and done work. Each task links to
the existing process dialog so the user can inspect assignment, verification, and worker output.
This keeps delegation explicit and serial behavior unchanged while creating a stable UI seam for a
future approval flow. Approval remains a follow-up because the current Master loop creates tasks
and delegates them in one runtime interaction; pausing it needs durable pending state and resume
semantics.
