# Knowledge retrieval filters research — 2026-09-13

Plan-to-Knowledge handoffs increase the value of the Knowledge surface but also increase its card
count. A local filter is the smallest useful retrieval improvement because bootstrap already
contains bounded item metadata and the existing detail/download actions can remain untouched.

Matching should be case-insensitive across name, handle, description, document filename, and
repository source. The selected workspace ID is checked before matching, and no transcript or file
bytes are read. Kind tabs and a no-results state make the result set explicit while preserving the
existing upload and inspection flow.
