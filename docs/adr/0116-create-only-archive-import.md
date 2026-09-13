# ADR 0116: Create-only archive import

Status: Accepted

Workspace exports can be imported as a new archived workspace. The server verifies the archive,
rejects workspace and entity ID collisions, stages owned files, and rolls back moved files when
state persistence fails. Imported workspaces remain archived until the user explicitly restores
them. Merge, remap, and overwrite restore remain separate policy decisions.
