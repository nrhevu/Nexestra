# ADR 0096: Keep a bounded Attention action history

Status: Accepted

## Context

Attention snooze and dismiss actions change the current derived workspace view, but users could not
see which triage actions had happened after an item disappeared. A history is useful for supervision
and recovery, provided it does not become a second transcript or leak task content.

## Decision

Persist a capped audit array in `state.json`, retaining at most 200 entries per workspace. Each entry
contains only the workspace ID, derived attention ID and kind, `snooze` or `dismiss` action, creation
time, and optional snooze expiry. The store exposes the newest 200 entries for a selected workspace
through `GET /api/attention/history?workspaceId=...`; foreign entries are excluded. Legacy action
calls without a kind use `unknown` for compatibility. The existing attention projection and state
filtering remain unchanged.

The Attention surface keeps the panel unloaded until the user presses **Refresh history**. It shows
action, kind, and timestamp only. Titles, details, prompts, transcripts, provider data, and
credentials never enter the audit record or response.

## Consequences

The log survives restart and gives a small, explicit supervision trail. Retention is bounded per
workspace rather than globally so one workspace cannot evict another workspace's recent actions.
This is an action log, not a complete event-sourcing system; malformed state still fails normal state
loading instead of being silently repaired.
