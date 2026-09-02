import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { ArtifactContent } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { required, requireQuery } from "../errors.js";

export function artifactRoutes(store: NexestraStore) {
  return (
    new Hono()
      .get("/", (c) => {
        const threadId = requireQuery(c, "threadId");
        required(store.getThread(threadId), "thread");
        return c.json(store.listArtifacts(threadId));
      })

      .get("/:artifactId", (c) =>
        c.json(required(store.getArtifact(c.req.param("artifactId")), "artifact")),
      )

      /**
       * Bytes live under `<NEXESTRA_HOME>/data`. Until a harness actually writes
       * them (M4), seeded artifacts only have the inline preview, so the response
       * says which of the two the caller got.
       */
      .get("/:artifactId/content", async (c) => {
        const artifact = required(store.getArtifact(c.req.param("artifactId")), "artifact");
        const root = resolve(store.dataDir);
        const candidate = resolve(join(root, normalize(artifact.path)));
        const inside = candidate === root || candidate.startsWith(root + sep);

        let payload: ArtifactContent = {
          artifactId: artifact.id,
          path: artifact.path,
          mimeType: artifact.mimeType,
          source: "preview",
          content: artifact.preview,
        };

        if (inside) {
          try {
            if ((await stat(candidate)).isFile()) {
              payload = { ...payload, source: "file", content: await readFile(candidate, "utf8") };
            }
          } catch {
            // Fall through to the preview.
          }
        }
        return c.json(payload);
      })
  );
}
