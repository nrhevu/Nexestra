# Review queue total research — 2026-09-12

The review queue already scans and sorts the complete workspace projection before taking a page.
Returning the projection length therefore adds a useful monitoring signal without another transcript
read or a new persistence field. A total is explicitly scoped to the active filters and request
snapshot; pagination remains keyset-based and coverage still reports unreadable conversations.

This is an implementation observation rather than a usability study. No external provider or
credential is involved, and no claim is made that totals alone improve review completion.
