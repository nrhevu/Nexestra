# Attention snooze durations research — 2026-09-12

The first attention snooze implementation used a one-hour browser action while the shared contract
already bounded server durations to seven days. A small set of fixed choices improves monitoring
workflow fit without exposing arbitrary timestamps or adding another persistence model.

The UI now offers one hour, four hours, and one day. The server still validates the numeric duration,
computes the expiry, and applies the same workspace isolation and restart behavior. These choices are
convenience controls; snoozes remain local metadata rather than an audit or notification history.
