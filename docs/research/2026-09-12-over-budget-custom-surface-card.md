# Over-budget custom surface card research

The existing custom-surface system safely allowlists built-in actions and renders selected-workspace
counts. Run history now has a cost filter and telemetry summary, so an `over_budget` card gives a
domain-specific price-review surface aligned with the harness goal.

Bootstrap computes the card count only when the configuration requests it and only for the selected
workspace. A complete telemetry snapshot returns the observed over-budget count, including zero when
none are flagged. If transcript coverage is incomplete, the field is omitted so the UI does not
claim a reliable zero. Clicking the card opens Run history with `cost=over_budget`; the existing
cursor and workspace checks remain authoritative.

The card stays declarative and read-only. It exposes no titles, transcript text, raw errors, provider
URLs, or credentials, and it remains an observed budget signal rather than billing enforcement.
