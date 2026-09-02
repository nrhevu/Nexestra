import type { Run } from "@nexestra/core";
import { useRuns } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";

export interface ActiveRun {
  readonly run: Run | undefined;
  /** Every run of the thread, newest last — what the run picker lists. */
  readonly runs: readonly Run[];
  readonly loading: boolean;
  /** True when the selection is following the newest run rather than pinned. */
  readonly following: boolean;
}

/**
 * Which run the Editor surface is showing.
 *
 * Default: the newest run that is still `running`, so opening the surface
 * mid-execution lands on the thing that is happening. With nothing running it
 * falls back to the most recent run, so the surface is never empty after the
 * work finishes. Clicking a run in the Task Board pins it (`selectedRunId`),
 * and the pin is dropped when the user picks "latest" again.
 */
export function useActiveRun(threadId: string): ActiveRun {
  const runs = useRuns(threadId);
  const selectedRunId = useUiStore((state) => state.selectedRunId);

  const ordered = [...(runs.data ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const pinned = selectedRunId ? ordered.find((run) => run.id === selectedRunId) : undefined;
  const latestRunning = [...ordered].reverse().find((run) => run.status === "running");

  return {
    run: pinned ?? latestRunning ?? ordered.at(-1),
    runs: ordered,
    loading: runs.isPending,
    following: !pinned,
  };
}
