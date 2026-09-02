/**
 * The harness registry — which adapters this process can drive, and what
 * `discover()` said about them.
 *
 * Two responsibilities, deliberately kept in one place:
 *
 * 1. **Construction.** `codex` and `opencode` come from their real adapter
 *    packages. Tests may inject adapters through `options.adapters`; production
 *    has no flag or setting that substitutes simulated execution.
 * 2. **Discovery.** `discover()` shells out (`codex --version`,
 *    `opencode serve`), so it is run once and cached. `GET /api/harnesses`
 *    reads the cache; `refresh()` re-runs it.
 *
 * `dispose()` is what a graceful shutdown calls: it kills the OpenCode servers
 * this process started. Codex has no server to stop — its processes are
 * children of a run, and cancelling the run kills the process group.
 */

import { createCodexAdapter } from "@nexestra/adapter-codex";
import { createOpenCodeAdapter } from "@nexestra/adapter-opencode";
import type { HarnessAdapter, HarnessId, HarnessInfo } from "@nexestra/core";
import { HarnessIdSchema } from "@nexestra/core";

/** Adapters may hold long-lived resources; OpenCode does, Codex does not. */
export type DisposableHarnessAdapter = HarnessAdapter & {
  dispose?: () => Promise<void>;
};

export interface HarnessRegistryOptions {
  /** Keep only these ids. Defaults to `NEXESTRA_HARNESSES`, else all of them. */
  readonly only?: readonly HarnessId[];
  /** Replace the whole map — what the tests inject. */
  readonly adapters?: Partial<Record<HarnessId, DisposableHarnessAdapter>>;
}

export interface HarnessRegistry {
  readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  /** Cached `discover()` results, one entry per registered harness adapter. */
  list(): Promise<HarnessInfo[]>;
  /** Re-run `discover()` and replace the cache. */
  refresh(): Promise<HarnessInfo[]>;
  /**
   * The last `discover()` results, synchronously. Empty until `list()` has
   * resolved once — which `apps/server/src/index.ts` does before it listens.
   */
  snapshot(): readonly HarnessInfo[];
  /**
   * What model this harness runs when nothing asks for one.
   *
   * The orchestrator prices a run against it whenever `RunSpec.model` is unset,
   * and the Task Board shows it so a card never claims a model the run did not
   * use. `undefined` when discovery has not finished or the harness did not say.
   */
  defaultModel(id: HarnessId): string | undefined;
  dispose(): Promise<void>;
}

/**
 * `NEXESTRA_HARNESSES=codex` — register only these ids.
 *
 * Useful for a deliberately cheap run: the cross-review pass picks a harness
 * *other* than the executor, so a process with one adapter reviews nothing and
 * spends nothing on a second model.
 */
export function requestedHarnessIds(): readonly HarnessId[] | undefined {
  const raw = process.env.NEXESTRA_HARNESSES;
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .flatMap((value) => {
      const parsed = HarnessIdSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  return ids.length > 0 ? ids : undefined;
}

export function createHarnessRegistry(options: HarnessRegistryOptions = {}): HarnessRegistry {
  const adapters: Partial<Record<HarnessId, DisposableHarnessAdapter>> =
    options.adapters ?? restrict(buildAdapters(), options.only ?? requestedHarnessIds());

  let cache: Promise<HarnessInfo[]> | null = null;
  let latest: readonly HarnessInfo[] = [];

  const describe = async (): Promise<HarnessInfo[]> => {
    const results: HarnessInfo[] = [];
    for (const [rawId, adapter] of Object.entries(adapters)) {
      const id = HarnessIdSchema.safeParse(rawId);
      if (id.success && adapter) results.push(await safeDiscover(id.data, adapter));
    }
    latest = results;
    return results;
  };

  return {
    adapters,
    list() {
      cache ??= describe();
      return cache;
    },
    refresh() {
      cache = describe();
      return cache;
    },
    snapshot() {
      return latest;
    },
    defaultModel(id) {
      return latest.find((info) => info.id === id)?.defaultModel;
    },
    async dispose() {
      for (const adapter of Object.values(adapters)) {
        await adapter?.dispose?.().catch(() => undefined);
      }
    },
  };
}

/* ---------------------------------------------------------------- internals */

function buildAdapters(): Partial<Record<HarnessId, DisposableHarnessAdapter>> {
  return {
    codex: createCodexAdapter(),
    opencode: createOpenCodeAdapter(),
  };
}

function restrict(
  adapters: Partial<Record<HarnessId, DisposableHarnessAdapter>>,
  only: readonly HarnessId[] | undefined,
): Partial<Record<HarnessId, DisposableHarnessAdapter>> {
  if (!only) return adapters;
  const kept: Partial<Record<HarnessId, DisposableHarnessAdapter>> = {};
  for (const id of only) if (adapters[id]) kept[id] = adapters[id];
  return kept;
}

/** A `discover()` that throws must not take the whole registry down with it. */
async function safeDiscover(id: HarnessId, adapter: HarnessAdapter): Promise<HarnessInfo> {
  try {
    const info = await adapter.discover();
    return { ...info, id, detectedAt: info.detectedAt ?? new Date().toISOString() };
  } catch (error) {
    return {
      id,
      available: false,
      models: [],
      sandboxModes: [],
      authOk: false,
      warnings: [error instanceof Error ? error.message : String(error)],
      detectedAt: new Date().toISOString(),
    };
  }
}
