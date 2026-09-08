# 2026-09-09 - Knowledge preview research

## Sources

- GitHub Docs, "Viewing and understanding files": https://docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files
- MDN, "Node.textContent": https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent

Fetched/read on 2026-09-09: /tmp/nexestra-preview-github-20260909.txt and
/tmp/nexestra-preview-mdn-20260909.txt.

## Findings

GitHub separates raw file content inspection from history browsing and downloads: a file view can
show content while history and raw/download actions remain distinct destinations. That supports two
interactions in Nexestra's detail dialog: a bounded content read and an explicit download of the
exact selected version.

MDN describes textContent as the concatenated text of a node's descendants, excluding markup
parsing. Combined with textContent semantics, a pre node is the simplest plain-text container:
uploaded Markdown or HTML cannot inject elements, scripts, images, or remote requests because the
browser receives only a text node. Rendering upload text as HTML was rejected even though Markdown
rendering is used elsewhere for agent replies, because Knowledge uploads are user-supplied files
that may be opened in other tools and are not trusted as app markup.

## Local design decisions

- GET /api/knowledge/:id/preview is a read-only endpoint; previewing never captures revisions or
  invokes providers.
- A 128 KiB text budget with a UTF-8-safe character boundary, checksum verification before
  decoding, and an upload-cap read bound prevent both surprise memory use and accepting a prefix
  hash for a file that grew past its recorded size.
- Known credentials are redacted from text and metadata, with a bounded lookahead to stop a
  credential that straddles the cutoff from leaking its prefix.
- Binary and invalid-UTF-8 uploads fall back to downloading rather than attempting partial or
  lossy rendering.

## Open questions

None blocking. Syntax highlighting, search-in-preview, and richer file-type rendering are possible
follow-ups but would each need their own bounded reader and ADR.

## Integrated browser verification

The feature was checked in the native browser against the same isolated, provider-free fixture as
[transcript search](2026-09-09-transcript-search.md). The current release guide showed its new text
and immutable version download; selecting the prior version showed the old text and that version's
download URL. The prior file contained literal script markup and Markdown remote-image syntax:
they remained text nodes, with zero embedded images, scripts or iframes in the preview.

The PDF fixture returned an unsupported-format message with its immutable version download. The
large text fixture returned exactly 131,072 source characters and the 128 KiB truncation notice.
The reading region was reachable by keyboard; PageDown moved its scroll position from 0 to 198px.
Both the metadata and every document version kept their original hashes after these reads.
The root's final combined check result is recorded in the transcript search report.
