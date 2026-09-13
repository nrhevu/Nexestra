# Run-history harness and model filters research — 2026-09-13

Immutable profile snapshots make historical labels trustworthy, but comparison still requires a
focused view. The run-history API now accepts harness and model label filters and binds them into the
existing keyset cursor. Filtering happens before pagination, so page boundaries and summaries refer
to the selected execution profile.

Legacy rows derive labels from the current profile for compatibility. Snapshot labels survive a
profile edit or agent deletion and remain bounded and credential-redacted. The browser adds simple
harness and loaded-model selectors and includes both values in the existing export envelope. No
transcript or run state is changed.
