# 0018 — Canonical path containment

## Context

macOS exposes the system temporary directory through both `/var/folders/...` and its physical
`/private/var/folders/...` path. Master tools canonicalized the workspace with `realpath` in some
checks while comparing it with lexical paths elsewhere. Ripgrep received paths such as
`../../../../../../private/var/...`, glob excluded valid repository files, and the sensitive-data
check could miss `.nexestra` paths reached through the temporary-directory alias.

## Decision

Use one canonical workspace path for each ripgrep invocation and every relative-path comparison in
file discovery. Canonicalize absolute requested paths through the nearest existing ancestor before
containment checks, preserving missing path suffixes for writes. Canonicalize both the workspace and
data roots before deciding whether a path is sensitive. Attached artifact reads compare canonical
physical paths rather than lexical strings.

## Consequences

Master list, glob, grep, read, edit, write, and patch tools behave consistently when the workspace is
reachable through a symlink alias. The data-root boundary remains effective across `/var` and
`/private/var`, and missing files can still be created inside a canonical workspace. An absolute
symlink outside the workspace that resolves into it remains readable only when it is an attached
artifact or resolves inside the canonical workspace; this preserves the existing local-file boundary.

## Status

Accepted for Milestone M9.
