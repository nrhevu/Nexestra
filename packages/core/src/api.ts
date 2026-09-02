import { z } from "zod";
import { HarnessInfoSchema } from "./harness.js";

/** `GET /api/health` */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Frames pushed over `/ws`. M0 only ever sends `hello`. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    serverVersion: z.string(),
    at: z.iso.datetime(),
  }),
  z.object({ type: z.literal("pong"), at: z.iso.datetime() }),
  z.object({
    type: z.literal("run_event"),
    threadId: z.string(),
    runId: z.string(),
    seq: z.number().int().nonnegative(),
    payload: z.unknown(),
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Frames the web app may send over `/ws`. */
export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), threadId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), threadId: z.string() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/** One node of the mocked worktree file tree rendered in the Editor surface. */
export const FileNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["dir", "file"]),
  status: z.enum(["unchanged", "added", "modified", "deleted"]).default("unchanged"),
  children: z.array(z.string()).default([]),
});
export type FileNode = z.infer<typeof FileNodeSchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  language: z.string(),
  content: z.string(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

/** `GET /api/mock/harnesses` — placeholder detection results for Settings. */
export const HarnessInfoListSchema = z.array(HarnessInfoSchema);
export type HarnessInfoList = z.infer<typeof HarnessInfoListSchema>;
