# Knowledge revision comparison research

Knowledge already records immutable document revisions and exposes bounded, credential-redacted
previews. Comparing two of those previews provides a useful review step before restoring or
promoting content, without adding a mutation path or sending document bytes to another service.

The implementation uses a small longest-common-subsequence line diff in the browser. It refuses
inputs above 128 KiB, 2,000 lines, 1.5 million comparison cells, or 4,000 output lines. Text is
obtained through the existing server preview endpoint, so stored credentials remain redacted. A
binary, invalid UTF-8, missing, or deleted revision falls back to metadata and download links.
Restore, merge, and automatic Knowledge promotion remain explicit separate actions.
