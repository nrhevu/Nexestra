/** Resolve the Master's active provider from persisted settings and server secrets. */
import type { AppSettings, MasterProvider, MasterRuntimeInfo } from "@nexestra/core";
import { DEFAULT_APP_SETTINGS } from "@nexestra/core";
import type { LlmClient } from "@nexestra/master";
import { createAnthropicLlmClient, createOpenAiLlmClient } from "@nexestra/master";

export interface MasterLlmRuntime {
  /** A stable proxy; each turn resolves the latest persisted provider settings. */
  readonly client: LlmClient;
  /** Read-only status for health checks and the Settings surface. */
  info(): MasterRuntimeInfo;
}

export interface CreateMasterLlmOptions {
  readonly settings?: () => AppSettings;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

interface ResolvedProvider {
  readonly provider: MasterProvider | null;
  readonly credential: string | undefined;
  readonly credentialPresent: boolean;
  readonly ready: boolean;
  readonly message?: string;
}

/**
 * Provider changes take effect on the next model request. Sessions can keep
 * their durable history; the proxy translates it at the provider boundary.
 */
export function createMasterLlm(options: CreateMasterLlmOptions = {}): MasterLlmRuntime {
  const readSettings = options.settings ?? (() => DEFAULT_APP_SETTINGS);
  const env = options.env ?? process.env;
  const clients = new Map<string, LlmClient>();

  const resolve = (): ResolvedProvider => resolveProvider(readSettings(), env);
  const client: LlmClient = {
    get model() {
      return resolve().provider?.model ?? "unconfigured";
    },
    async *stream(request) {
      const selected = resolve();
      if (!selected.provider || !selected.ready) {
        throw new Error(
          selected.message ??
            "No Master provider is ready. Configure one in Settings before sending a message.",
        );
      }

      const cacheKey = JSON.stringify([selected.provider, selected.credential]);
      let current = clients.get(cacheKey);
      if (!current) {
        current = clientFor(selected.provider, selected.credential, options.fetch);
        clients.set(cacheKey, current);
      }
      for await (const event of current.stream(request)) yield event;
    },
  };

  return {
    client,
    info() {
      return runtimeInfo(resolve());
    },
  };
}

export function resolveProvider(
  settings: AppSettings,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const enabled = settings.masterProviders.filter((provider) => provider.enabled);
  let provider = settings.activeMasterProviderId
    ? enabled.find((entry) => entry.id === settings.activeMasterProviderId)
    : enabled.find((entry) => credentialFor(entry, env) !== undefined || !entry.apiKeyEnv);

  if (!provider && settings.activeMasterProviderId) {
    return {
      provider: null,
      credential: undefined,
      credentialPresent: false,
      ready: false,
      message: `The active Master provider "${settings.activeMasterProviderId}" is missing or disabled.`,
    };
  }
  provider ??= enabled[0];
  if (!provider) {
    return {
      provider: null,
      credential: undefined,
      credentialPresent: false,
      ready: false,
      message: "No Master provider is configured.",
    };
  }

  const credential = credentialFor(provider, env);
  const credentialPresent = credential !== undefined || !provider.apiKeyEnv;
  return {
    provider,
    credential,
    credentialPresent,
    ready: credentialPresent,
    ...(credentialPresent
      ? {}
      : {
          message: `Set ${provider.apiKeyEnv} on the server to use ${provider.name}.`,
        }),
  };
}

function credentialFor(provider: MasterProvider, env: NodeJS.ProcessEnv): string | undefined {
  const configured = provider.apiKeyEnv ? env[provider.apiKeyEnv]?.trim() : undefined;
  if (configured) return configured;
  if (provider.id === "anthropic") return env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;
  return undefined;
}

function clientFor(
  provider: MasterProvider,
  credential: string | undefined,
  fetchImpl: typeof globalThis.fetch | undefined,
): LlmClient {
  if (provider.protocol === "openai-responses") {
    return createOpenAiLlmClient({
      apiKey: credential,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }
  return createAnthropicLlmClient({
    apiKey: credential,
    baseUrl: provider.baseUrl,
    model: provider.model,
  });
}

function runtimeInfo(selected: ResolvedProvider): MasterRuntimeInfo {
  const provider = selected.provider;
  return {
    client:
      provider?.protocol === "openai-responses"
        ? "openai"
        : provider?.protocol === "anthropic-messages"
          ? "anthropic"
          : "unconfigured",
    model: provider?.model ?? "",
    apiKeyPresent: selected.credentialPresent,
    providerId: provider?.id ?? null,
    ...(provider
      ? {
          providerName: provider.name,
          protocol: provider.protocol,
          ...(provider.apiKeyEnv ? { credentialEnv: provider.apiKeyEnv } : {}),
        }
      : {}),
    credentialPresent: selected.credentialPresent,
    ready: selected.ready,
    ...(selected.message ? { message: selected.message } : {}),
  };
}
