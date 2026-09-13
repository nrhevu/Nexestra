# Durable plan provenance

The Master already creates durable Taskboard tasks before delegation, but the plan title was only
retained inside each task description. A generated plan identifier and bounded title make the source
of a task explicit in the board and preserve that context through export/import and restart without
introducing a second execution queue.
