# ADR 0123: Durable plan provenance

Status: Accepted

Tasks created by the Master `plan` tool carry a generated `planId` and the bounded plan title. The
metadata is persisted with the Task, exported with workspace data, and shown on Taskboard cards so a
user can distinguish planned work from manually created tasks after refresh or restart.

The plan metadata does not grant execution authority and cannot contain credentials or commands. Task
assignment, verification, and status transitions continue to use the existing workspace-scoped flows.
