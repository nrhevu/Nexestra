/**
 * `StorageMasterStore` — `MasterStore` on top of `NexestraStore`.
 *
 * Two responsibilities, both append-only in spirit:
 *
 * - the raw model conversation (`master_messages`), stored **verbatim**. The
 *   session pushes `response.content` unchanged so thinking blocks keep their
 *   signatures and compaction blocks stay usable; anything that normalised or
 *   summarised on the way in would silently break the next request.
 * - the derived thread state (`master_state`): phase, spec, plan, usage,
 *   budget and the pending tool call, as one JSON row per thread.
 *
 * A row that fails to parse is treated as "no state" rather than throwing: a
 * thread whose state was written by an older build should start a fresh
 * Master rather than wedge the server.
 */
import type { Spec } from "@nexestra/core";
import { ThreadPhaseSchema } from "@nexestra/core";
import type { LlmMessageParam, MasterStore, MasterThreadState } from "@nexestra/master";
import type { NexestraStore } from "@nexestra/storage";

export function createStorageMasterStore(store: NexestraStore): MasterStore {
  return {
    async loadState(threadId) {
      return parseState(threadId, store.getMasterState(threadId));
    },

    async saveState(state) {
      store.putMasterState(state.threadId, state);
    },

    async appendMessages(threadId, messages) {
      store.appendMasterMessages(
        threadId,
        messages.map((message) => ({
          role: message.role,
          content: message.content as unknown,
        })),
      );
    },

    async loadMessages(threadId) {
      return store.listMasterMessages(threadId) as LlmMessageParam[];
    },
  };
}

/**
 * Rehydrate a persisted state row.
 *
 * Only the phase and the usage totals are checked, because those are what the
 * session's guards read. The spec is deliberately **not** run through
 * `SpecSchema`: a spec being drafted is legitimately incomplete — an empty
 * `goal` while the Master is still asking questions — and the domain schema
 * rejects exactly that. Validating here would quietly throw the thread's state
 * away mid-clarification and restart it at `intake`. The published copy in the
 * `specs` table is the validated one; this is the draft.
 */
function parseState(threadId: string, raw: unknown): MasterThreadState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const phase = ThreadPhaseSchema.safeParse(value.phase);
  if (!phase.success) return null;

  const usage = value.usage as MasterThreadState["usage"] | undefined;
  if (!usage || typeof usage.costUSD !== "number") return null;

  const spec = (value.spec ?? null) as Spec | null;

  return {
    threadId,
    phase: phase.data,
    spec,
    plan: (value.plan ?? null) as MasterThreadState["plan"],
    specApproved: value.specApproved === true,
    planAccepted: value.planAccepted === true,
    questionsAsked: typeof value.questionsAsked === "number" ? value.questionsAsked : 0,
    usage,
    budgetUSD: typeof value.budgetUSD === "number" ? value.budgetUSD : 20,
    budgetWarned: value.budgetWarned === true,
    pending: (value.pending ?? null) as MasterThreadState["pending"],
  };
}
