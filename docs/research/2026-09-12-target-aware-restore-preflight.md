# Target-aware restore preflight research

A verified archive contains only its own manifest paths; restore safety also depends on what already
exists in the target workspace. The target-aware step keeps the archive local and asks the loopback
server for a bounded archive-relative path inventory derived through the existing export ownership
checks. The browser computes the intersection without sending archive bytes or transcript contents.

The plan distinguishes an empty checked conflict set from an unchecked one. Inventory failures do not
produce a false clean result. The endpoint is GET-only and returns no credentials, provider settings,
repository files, clones or worktrees. The path list is a read-time snapshot, so actual restore must
revalidate ownership and implement merge/rollback semantics before writing.
