# Archived workspace recovery-manifest surface research — 2026-09-13

Reversible archival preserved workspace data and offered restore, but a user had to restore before
checking what files and hashes were still present. That weakens local-first recovery review.

Settings now lists archived workspaces with a read-only manifest action. The server reuses the
credential-free bounded recovery manifest and allows archived IDs, while the browser renders only a
bounded path/size list. No workspace activation, file write, archive upload, or restore policy is
involved; restore remains a separate explicit operation.
