import type { MasterError, MasterQuestion, MasterStreamPayload } from "@nexestra/core";
import { MasterStreamPayloadSchema } from "@nexestra/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keys } from "./api.js";
import { eventsClient } from "./events.js";

/**
 * The live view of a Master turn.
 *
 * The persisted transcript (`messages`) only gains the assistant's reply once
 * the turn is over, so while one is in flight this hook holds the half-written
 * state: the text as it streams, the tool calls as they resolve, and the
 * question or approval that suspended it.
 *
 * It reads the same `/ws` connection everything else does — `master.*` events
 * are ordinary store events — so there is no second transport and a reload
 * simply falls back to `GET /master/state`.
 */

export interface LiveToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly ok?: boolean;
  readonly output?: unknown;
}

export interface MasterStream {
  /** True between `master.started` and `master.done`. */
  readonly busy: boolean;
  readonly turnId: string | null;
  readonly text: string;
  readonly toolCalls: readonly LiveToolCall[];
  /** The `ask_user` card of the turn that just suspended, if any. */
  readonly question: { readonly callId: string; readonly questions: MasterQuestion[] } | null;
  readonly error: MasterError | null;
  readonly costUSD: number | null;
  /** Clear the finished turn once its `Message` has arrived in the timeline. */
  readonly dismiss: () => void;
}

interface StreamState {
  busy: boolean;
  turnId: string | null;
  text: string;
  toolCalls: LiveToolCall[];
  question: MasterStream["question"];
  error: MasterError | null;
  costUSD: number | null;
}

const EMPTY: StreamState = {
  busy: false,
  turnId: null,
  text: "",
  toolCalls: [],
  question: null,
  error: null,
  costUSD: null,
};

export function useMasterStream(threadId: string): MasterStream {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>(EMPTY);
  // The turn this hook is following. A `master.*` event for an older turn (a
  // late frame after a reconnect) must not resurrect a finished card.
  const turnRef = useRef<string | null>(null);

  useEffect(() => {
    setState(EMPTY);
    turnRef.current = null;
    if (!threadId) return;

    const stopWatching = eventsClient.watchThread(threadId);
    const stopListening = eventsClient.onEvent((event) => {
      if (event.threadId !== threadId) return;
      if (!event.type.startsWith("master.")) return;
      const parsed = MasterStreamPayloadSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const payload = parsed.data;

      if (payload.type === "master.started") turnRef.current = payload.turnId;
      else if (turnRef.current !== payload.turnId) return;

      setState((current) => reduce(current, payload));

      if (payload.type === "master.done") {
        // The turn's durable output (the assistant message, the spec, the
        // plan) lands as its own events, but re-reading is the cheap way to be
        // certain the timeline and the phase badge agree with the server.
        void client.invalidateQueries({ queryKey: keys.messages(threadId) });
        void client.invalidateQueries({ queryKey: keys.masterState(threadId) });
        void client.invalidateQueries({ queryKey: keys.tasks(threadId) });
        void client.invalidateQueries({ queryKey: keys.plan(threadId) });
      }
    });

    return () => {
      stopListening();
      stopWatching();
    };
  }, [client, threadId]);

  const dismiss = useCallback(() => {
    setState((current) => (current.busy ? current : { ...EMPTY, question: current.question }));
  }, []);

  return useMemo(() => ({ ...state, dismiss }), [state, dismiss]);
}

function reduce(current: StreamState, payload: MasterStreamPayload): StreamState {
  switch (payload.type) {
    case "master.started":
      return { ...EMPTY, busy: true, turnId: payload.turnId };

    case "master.text_delta":
      return { ...current, text: current.text + payload.text };

    case "master.tool_call":
      return {
        ...current,
        toolCalls: [
          ...current.toolCalls,
          { callId: payload.callId, name: payload.name, input: payload.input },
        ],
      };

    case "master.tool_result":
      return {
        ...current,
        toolCalls: current.toolCalls.map((call) =>
          call.callId === payload.callId
            ? { ...call, ok: payload.ok, output: payload.output }
            : call,
        ),
      };

    case "master.question":
      return {
        ...current,
        question: { callId: payload.callId, questions: [...payload.questions] },
      };

    case "master.usage":
      return { ...current, costUSD: payload.thread.costUSD };

    case "master.error":
      return { ...current, error: payload.error };

    case "master.done":
      return { ...current, busy: false };

    default:
      return current;
  }
}
