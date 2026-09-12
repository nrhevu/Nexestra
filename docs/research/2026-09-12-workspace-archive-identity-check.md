# Workspace archive identity check research

The local archive inspector already validates the ZIP structure, manifest coverage, CRC values, and
SHA-256 hashes in a browser Worker. Its manifest includes the exported workspace ID and name, while
restore remains intentionally unsupported. Comparing that manifest identity with the active workspace
is a small portability improvement: it catches selecting another workspace's healthy snapshot before
manual review or transfer.

The implementation treats the workspace ID as authoritative and the name as an informational
comparison. It passes only bounded identity strings through the existing Worker request and returns a
boolean match object. No transcript or artifact bytes leave the browser, and the check does not imply
authenticity, completeness, or importability.
