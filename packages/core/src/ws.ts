import { z } from "zod";
import { NexestraEventSchema } from "./events.js";

/**
 * The `/ws` protocol from M1 onwards. It supersedes the M0 `ClientFrame` /
 * `ServerFrame` pair in `api.ts`, which is kept only so nothing that still
 * imports it breaks.
 *
 * A client subscribes to a thread (and optionally to a workspace, to receive
 * workspace-level events such as `thread.created`). The server pushes one
 * `event` message per appended event that matches a live subscription.
 */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    threadId: z.string().optional(),
    workspaceId: z.string().optional(),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    threadId: z.string().optional(),
    workspaceId: z.string().optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    serverVersion: z.string(),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("subscribed"),
    threadIds: z.array(z.string()).default([]),
    workspaceIds: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal("event"), event: NexestraEventSchema }),
  z.object({ type: z.literal("pong"), at: z.iso.datetime() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

/** How often the server sends a protocol-level ping to detect dead sockets. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
