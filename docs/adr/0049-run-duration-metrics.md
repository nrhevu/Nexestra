# ADR 0049 - Run duration metrics

## Status

Accepted.

## Context

Nexestra's run history exposes lifecycle timestamps but leaves users to calculate elapsed time
manually. Comparing run duration is useful when choosing a harness or model and when diagnosing
slow delegated work.

## Decision

Run history responses include an optional `durationMs` on terminal runs (`completed`, `failed`, or
`interrupted`). The server derives it from the canonical run `createdAt` and terminal `updatedAt`
timestamps. Active and queued runs omit the field because their end time is unknown. Invalid or
backwards timestamps omit the metric rather than presenting a misleading value. The UI renders
the metric alongside status, attempt, and lifecycle dates.

No second persistence store or transcript event is introduced; older transcripts continue to work
without migration.

## Limits

The value is wall-clock elapsed time and includes queueing and retries represented by that run's
lifecycle. It does not report provider token usage, billing, or CPU time. A run whose timestamps
are malformed has no duration until a later valid lifecycle event is written.
