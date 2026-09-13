# Restore preflight conflict categories research — 2026-09-13

The workspace export workflow already verifies archive hashes and exposes a read-only target path
inventory. A list of collisions is insufficient for a harness that must preserve local work: an
archive entry may already exist with exactly the same bytes, or it may have changed since export.

This slice upgrades the target inventory to include the bounded recovery-manifest hashes and compares
it with the verified archive manifest in the browser. Results are page-independent and deterministic:
absent paths are safe to create, matching size/hash paths are existing-identical, and all other
collisions are conflicts. Legacy path-only responses are handled conservatively as conflicts.

The preflight remains read-only and keeps archive bytes in the browser. It does not decide whether a
future restore should skip, overwrite, merge, or roll back any category.
