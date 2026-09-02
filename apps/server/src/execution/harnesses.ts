/**
 * The harness registry — which adapters this process can drive, and what
 * `discover()` said about them.
 *
 * Two responsibilities, deliberately kept in one place:
 *
 * 1. **Construction.** `codex` and `opencode` come from their adapter
 *    packages. The orchestrator's scripted `fake` adapter is registered as
 *    well when `NEXESTRA_FAKE_HARNESS=1` or `AppSettings.enableFakeHarness` is
 *    on — and when it is, it *stands in for* `codex` and `opencode` too, so a
 *    plan that names a real harness still runs end to end without spending a
 *    single token. Nothing is hidden: `discover()` on a stand-in says so in
 *    its warnings, and the Settings surface renders them.
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
import { createFakeHarnessAdapter } from "@nexestra/orchestrator";
import { createDemoHarnessScript } from "./fake-script.js";

/** Adapters may hold long-lived resources; OpenCode does, Codex does not. */
export type DisposableHarnessAdapter = HarnessAdapter & {
  dispose?: () => Promise<void>;
};

export interface HarnessRegistryOptions {
  /** Turn the scripted stand-in on. Defaults to the env / settings decision. */
  readonly fake?: boolean;
  /** Keep only these ids. Defaults to `NEXESTRA_HARNESSES`, else all of them. */
  readonly only?: readonly HarnessId[];
  /** Replace the whole map — what the tests inject. */
  readonly adapters?: Partial<Record<HarnessId, DisposableHarnessAdapter>>;
}

export interface HarnessRegistry {
  readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  /** True when the registered adapters are the scripted stand-in. */
  readonly simulated: boolean;
  /** Cached `discover()` results, one entry per known harness id. */
  list(): Promise<HarnessInfo[]>;
  /** Re-run `discover()` and replace the cache. */
  refresh(): Promise<HarnessInfo[]>;
  dispose(): Promise<void>;
}

/** `NEXESTRA_FAKE_HARNESS=1` — the env half of the decision. */
export function fakeHarnessRequested(): boolean {
  const value = process.env.NEXESTRA_FAKE_HARNESS;
  return value === "1" || value === "true";
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
  const simulated = options.adapters ? false : (options.fake ?? false);
  const adapters: Partial<Record<HarnessId, DisposableHarnessAdapter>> =
    options.adapters ?? restrict(buildAdapters(simulated), options.only ?? requestedHarnessIds());

  let cache: Promise<HarnessInfo[]> | null = null;

  const describe = async (): Promise<HarnessInfo[]> => {
    const results: HarnessInfo[] = [];
    for (const id of HarnessIdSchema.options) {
      const adapter = adapters[id];
      if (!adapter) {
        results.push(unavailable(id, simulated));
        continue;
      }
      results.push(await safeDiscover(id, adapter));
    }
    return results;
  };

  return {
    adapters,
    simulated,
    list() {
      cache ??= describe();
      return cache;
    },
    refresh() {
      cache = describe();
      return cache;
    },
    async dispose() {
      for (const adapter of Object.values(adapters)) {
        await adapter?.dispose?.().catch(() => undefined);
      }
    },
  };
}

/* ---------------------------------------------------------------- internals */

function buildAdapters(simulated: boolean): Partial<Record<HarnessId, DisposableHarnessAdapter>> {
  if (simulated) {
    // Separate instances per id: the cross-review pass picks a harness *other*
    // than the executor, and identity is how the engine tells them apart.
    return {
      fake: fakeAdapter("fake"),
      codex: fakeAdapter("codex"),
      opencode: fakeAdapter("opencode"),
    };
  }
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

function fakeAdapter(id: HarnessId): DisposableHarnessAdapter {
  return createFakeHarnessAdapter({
    id,
    script: createDemoHarnessScript(id),
    info: {
      version: "simulated",
      models: [`${id}/simulated`],
      defaultModel: `${id}/simulated`,
      warnings: [
        `Simulated harness: NEXESTRA_FAKE_HARNESS is on, so no ${id} process is spawned. ` +
          "Runs write placeholder files into the worktree and cost nothing.",
      ],
    },
  });
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

function unavailable(id: HarnessId, simulated: boolean): HarnessInfo {
  const warnings =
    id === "acp"
      ? ["Not implemented yet — planned after the first two adapters ship."]
      : simulated
        ? ["Not registered: this process is running with the simulated harness."]
        : ["Not registered in this process."];
  return {
    id,
    available: false,
    models: [],
    sandboxModes: [],
    authOk: false,
    warnings,
    detectedAt: new Date().toISOString(),
  };
}
