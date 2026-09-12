# Review case export research — 2026-09-12

The review queue now shows the response, feedback note and (when durable provenance exists) the
triggering prompt. That projection is enough to make a small evaluation case, but a reviewer still
had to copy rows manually before using another local tool. Manual copying is error-prone and often
drops the IDs needed to return to the canonical message.

The selected workflow is a browser-generated JSON packet of the already loaded queue rows. It keeps
the server as the source of truth and avoids a second transcript reader or a new persisted artifact.
The packet has a versioned format, carries stable prompt/message/run IDs, and caps cases at 200. The
queue API already bounds and redacts the text; the export does not claim to discover unknown secrets.
Pagination is explicit so the user controls which rows leave the surface. Automatic scoring,
prompt mutation, and upload to an evaluation provider remain out of scope.
