# Plan to Knowledge handoff research — 2026-09-13

After adding plan progress, bounded export, and dependency gating, the smallest useful knowledge
transfer is a reviewed snapshot from a Taskboard card. The existing Knowledge document endpoint
already provides naming, handle validation, and workspace refresh, so a client-side Markdown file
can reuse that confirmation path without a new server workflow.

The snapshot should carry plan/task metadata only: title, plan ID, status counts, dependency IDs,
and worker labels. It should cap plans and tasks, flatten user text to one line, and omit task
descriptions, prompts, transcripts, credentials, repository IDs, branches, and worktree paths.
Opening the dialog must not upload anything; the user confirms the generated name and handle before
the existing document POST. This keeps Knowledge useful for later agents while preserving the
single-user local-first privacy boundary.
