# Read-only restore preflight research

The export manifest and local ZIP inspector already provide a trustworthy integrity boundary. Before
implementing import, users need an inventory of what a snapshot would contain and an explicit record
of what remains unsupported. The preflight derives bounded counts from redacted `state.json` and
manifest topology after CRC and SHA-256 verification.

The plan keeps workspace identity, collection counts, `importSupported`, blockers, and an explicit
`pathConflicts.checked` flag. Because it never opens a restore target, an empty conflict list is not
reported as conflict-free. Archive parser rules reject credential, repository, clone, worktree and
unknown paths before they can enter the plan. No server call or mutation occurs; merge semantics,
rollback, and target conflict checks remain requirements for a later restore design.
