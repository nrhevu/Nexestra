# Create-only archive import

Archive import now has a bounded server path: ZIP limits, manifest/hash inspection, state schema
validation, collision checks, staged file moves, and rollback on persistence failure. The imported
workspace is archived so it cannot silently become the active execution target. Merge and overwrite
semantics remain intentionally unsupported.
