import { z } from "zod";
import { EntityBaseSchema, IdSchema, TimestampSchema } from "./common.js";

/** What the user is being asked to approve (PLAN.md §3). */
export const ApprovalKindSchema = z.enum([
  "permission",
  "sandbox_escalation",
  "spend",
  "merge",
  "destructive",
  "spec",
  /** An acceptance criterion whose `verification.kind` is `manual_review` (M5). */
  "manual_verification",
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  taskId: IdSchema.optional(),
  runId: IdSchema.optional(),
  kind: ApprovalKindSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  risk: z.enum(["low", "high"]).default("low"),
  status: ApprovalStatusSchema,
  requestedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
  resolvedBy: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
