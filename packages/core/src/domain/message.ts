import { z } from "zod";
import { EntityBaseSchema, IdSchema } from "./common.js";

export const MessageRoleSchema = z.enum(["user", "master", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** `#task`, `#file`, `#memory`, `#artifact` references embedded in a message. */
export const MessageReferenceSchema = z.object({
  kind: z.enum(["task", "file", "memory", "artifact", "thread", "run"]),
  id: z.string().min(1),
  label: z.string().min(1),
});
export type MessageReference = z.infer<typeof MessageReferenceSchema>;

/** A tool invocation made by the Master while producing a message. */
export const MessageToolCallSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  output: z.unknown().optional(),
  ok: z.boolean().optional(),
});
export type MessageToolCall = z.infer<typeof MessageToolCallSchema>;

/**
 * Inline block rendered under a message in the Chat surface: a plan preview,
 * a diff, a test report. In M0 these are mocked; from M4 they point at real
 * artifacts produced by a harness run.
 */
export const MessageAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact"),
    artifactId: IdSchema,
    title: z.string().min(1),
    preview: z.string().default(""),
  }),
  z.object({
    kind: z.literal("plan_preview"),
    planId: IdSchema,
    title: z.string().min(1),
    taskTitles: z.array(z.string()).default([]),
  }),
  z.object({
    kind: z.literal("diff"),
    title: z.string().min(1),
    path: z.string().min(1),
    patch: z.string().default(""),
  }),
  z.object({
    kind: z.literal("test_report"),
    title: z.string().min(1),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    output: z.string().default(""),
  }),
]);
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const MessageSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  role: MessageRoleSchema,
  /** Rendered as plain monospace text; no markdown engine in M0. */
  content: z.string(),
  references: z.array(MessageReferenceSchema).default([]),
  toolCalls: z.array(MessageToolCallSchema).default([]),
  attachments: z.array(MessageAttachmentSchema).default([]),
});
export type Message = z.infer<typeof MessageSchema>;
