# Reversible Attention clear

The Attention surface now exposes Restore for prior snooze and dismissal rows. The server removes
only the matching workspace state and appends a `clear` audit event; no task, run, or transcript
content is loaded into the audit trail.
