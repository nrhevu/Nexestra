# Bulk stop pending runs research — 2026-09-13

After adding single-run stopping to Needs attention, repeated approval/input stalls still require
one click per row. Review queue selection already establishes a familiar pattern: explicit
checkboxes, a count, a busy lock, and partial-success retention.

Only active Master approval/input rows should participate. Calls stay sequential so each stop has a
clear result, while the selected workspace refreshes once after the batch. Worker assignments and
task failures remain excluded because their Taskboard process controls own repository cleanup.
