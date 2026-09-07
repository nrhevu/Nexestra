# ADR 0024: tasks from saved briefs

Status: accepted, implemented.

## Problem

Users had to re-enter a shared brief's title, outcome and verification criteria in Taskboard.
Copying only the short task description could lose deliverables, constraints and open questions.
Looking up the latest thread brief at execution could also replace the source scope after planning.

## Decision

The Work Brief surface offers Draft task for its saved version. It opens the existing editable
task form, prefilled with title, outcome, work type, checks and the linked conversation. Unsaved
or stale local briefs must be saved/reloaded first. Creating the task does not invoke an agent.
Draft briefs are allowed because task drafting is separate from execution and scope confirmation.

The create-task command accepts an expected sourceBriefRevision. Under its write lock the store
verifies the thread/workspace and revision, then copies the complete host-owned brief into the task.
The browser cannot provide the snapshot itself. Stale source revisions fail without creating a task.
Task contracts retain this source snapshot through assignment and restart. The UI exposes its full
contents in the task form and process view, without squeezing them into the 2,000-character task
description or silently truncating them.

## Consequences and limits

Tasks derived from a brief receive that saved source as their invocation's brief context; other
tasks retain the existing goal-brief/current-thread fallback. The overall goal objective still
accompanies goal assignments. TASK.md now also includes pinned brief context for directory work.
Explicit current task requirements take precedence over source context; unresolved conflicts
must be reported. Task edits do not rewrite the historical source. Create a new task from a newer
brief to adopt a different source snapshot.

This is a reviewable handoff, not AI decomposition or automatic execution. The existing Master plan
tool still creates task requirements independently; automatic brief provenance for its plan steps
is not implied by this UI flow. Later task edits can diverge from their source and are revisioned
as usual. Multi-task brief decomposition and explicit source rebasing remain future work.
