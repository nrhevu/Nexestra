import { z } from "zod";
import { EntityBaseSchema, IdSchema } from "./common.js";

/** Node type in the memory graph; drives node styling in surface 4. */
export const MemoryTypeSchema = z.enum([
  "goal",
  "requirement",
  "decision",
  "research",
  "architecture",
  "task",
  "artifact",
  "lesson",
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/** Typed edge between two memory nodes. */
export const MemoryLinkTypeSchema = z.enum([
  "derives_from",
  "blocks",
  "implements",
  "verified_by",
  "relates_to",
  "supersedes",
]);
export type MemoryLinkType = z.infer<typeof MemoryLinkTypeSchema>;

export const MemoryLinkSchema = z.object({
  type: MemoryLinkTypeSchema,
  targetId: IdSchema,
  note: z.string().default(""),
});
export type MemoryLink = z.infer<typeof MemoryLinkSchema>;

/** Where this memory came from, so `[Open source]` can jump to it. */
export const MemorySourceSchema = z.object({
  kind: z.enum(["message", "run", "artifact", "task", "spec", "user"]),
  id: IdSchema,
  label: z.string().min(1),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

export const MemorySchema = EntityBaseSchema.extend({
  threadId: IdSchema.optional(),
  type: MemoryTypeSchema,
  title: z.string().min(1),
  content: z.string().default(""),
  links: z.array(MemoryLinkSchema).default([]),
  source: MemorySourceSchema.optional(),
  tags: z.array(z.string()).default([]),
  /** Written by the Master via tool call, or edited by the user. */
  authoredBy: z.enum(["master", "user"]).default("master"),
});
export type Memory = z.infer<typeof MemorySchema>;
