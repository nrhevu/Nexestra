import { z } from "zod";
import { EntityBaseSchema, IdSchema } from "./common.js";

export const ArtifactKindSchema = z.enum([
  "diff",
  "patch",
  "file",
  "test_report",
  "log",
  "screenshot",
  /** Findings produced by a cross-review run (M5). */
  "review",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * Evidence produced by a run. The bytes live under `~/.nexestra/data/`;
 * this row is the metadata plus a short inline preview for the UI.
 */
export const ArtifactSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  taskId: IdSchema.optional(),
  runId: IdSchema.optional(),
  kind: ArtifactKindSchema,
  title: z.string().min(1),
  /** Path relative to the workspace data directory. */
  path: z.string().min(1),
  mimeType: z.string().default("text/plain"),
  sizeBytes: z.number().int().nonnegative().default(0),
  preview: z.string().default(""),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
