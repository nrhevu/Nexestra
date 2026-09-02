/**
 * Artifact writing.
 *
 * `NexestraStore.recordArtifact()` stores metadata plus a short preview; the
 * bytes are ours to write, under `<dataDir>/<threadId>/<artifactId>.<ext>`.
 * That is exactly what `GET /api/artifacts/:id/content` reads back, so an
 * artifact recorded here renders in the Editor surface without further wiring.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Artifact, ArtifactKind } from "@nexestra/core";
import { type NexestraStore, newId } from "@nexestra/storage";

const PREVIEW_BYTES = 2000;

const EXTENSIONS: Record<ArtifactKind, string> = {
  diff: "diff",
  patch: "patch",
  file: "txt",
  test_report: "txt",
  log: "log",
  screenshot: "png",
  review: "json",
};

export interface WriteArtifactInput {
  store: NexestraStore;
  threadId: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  taskId?: string;
  runId?: string;
  mimeType?: string;
  /** Longer content is truncated with a marker before it is written. */
  maxBytes?: number;
}

/** Write the bytes, then record the row. Returns the recorded `Artifact`. */
export async function writeArtifact(input: WriteArtifactInput): Promise<Artifact> {
  const id = newId("art");
  const relative = path.posix.join(input.threadId, `${id}.${EXTENSIONS[input.kind]}`);
  const absolute = path.join(
    input.store.dataDir,
    input.threadId,
    `${id}.${EXTENSIONS[input.kind]}`,
  );

  const max = input.maxBytes ?? 1024 * 1024;
  let content = input.content;
  if (Buffer.byteLength(content, "utf8") > max) {
    content = `${content.slice(0, max)}\n… truncated at ${max} bytes\n`;
  }

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");

  return input.store.recordArtifact({
    id,
    threadId: input.threadId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    kind: input.kind,
    title: input.title,
    path: relative,
    mimeType: input.mimeType ?? "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    preview: content.slice(0, PREVIEW_BYTES),
  });
}
