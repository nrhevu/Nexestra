/** Resolve the Master's active provider from persisted settings and server secrets. */
import type { AppSettings, MasterProvider, MasterRuntimeInfo } from "@nexestra/core";
import { DEFAULT_APP_SETTINGS, masterProviderAuth } from "@nexestra/core";
import type { LlmClient } from "@nexestra/master";
import {
  createAnthropicLlmClient,
  createOpenAiChatLlmClient,
  createOpenAiLlmClient,
} from "@nexestra/master";

export interface MasterLlmRuntime {
  /** A stable proxy; each turn resolves the latest persisted provider settings. */
  readonly client: LlmClient;
  /** Read-only status for health checks and the Settings surface. */
  info(threadId?: string): MasterRuntimeInfo;
}

export interface MasterAgentSelection {
  readonly providerId: string;
  readonly model: string;
  readonly instructions?: string;
}

export interface CreateMasterLlmOptions {
  readonly settings?: () => AppSettings;
  readonly credentials?: ProviderCredentialReader;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  /** Resolve the Nexestra agent assigned to a thread, if one is selected. */
  readonly selection?: (threadId: string) => MasterAgentSelection | undefined;
}

export interface ProviderCredentialReader {
  get(providerId: string): string | undefined;
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

  const resolve = (threadId?: string): ResolvedProvider =>
    resolveProvider(
      readSettings(),
      env,
      options.credentials,
      threadId ? options.selection?.(threadId) : undefined,
    );
  const client: LlmClient = {
    get model() {
      return resolve().provider?.model ?? "unconfigured";
    },
    async *stream(request) {
      const profile = request.threadId ? options.selection?.(request.threadId) : undefined;
      const selected = resolveProvider(readSettings(), env, options.credentials, profile);
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
      const effectiveRequest = profile?.instructions
        ? {
            ...request,
            systemSuffix: [
              request.systemSuffix,
              "# Selected agent instructions",
              profile.instructions,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        : request;
      for await (const event of current.stream(effectiveRequest)) yield event;
    },
  };

  return {
    client,
    info(threadId) {
      return runtimeInfo(resolve(threadId));
    },
  };
}

export function resolveProvider(
  settings: AppSettings,
  env: NodeJS.ProcessEnv = process.env,
  credentials?: ProviderCredentialReader,
  selection?: MasterAgentSelection,
): ResolvedProvider {
  const enabled = settings.masterProviders.filter((provider) => provider.enabled);
  let provider = selection
    ? enabled.find((entry) => entry.id === selection.providerId)
    : settings.activeMasterProviderId
      ? enabled.find((entry) => entry.id === settings.activeMasterProviderId)
      : enabled.find(
          (entry) =>
            credentialFor(entry, env, credentials) !== undefined ||
            masterProviderAuth(entry) === "none",
        );

  if (!provider && selection) {
    return {
      provider: null,
      credential: undefined,
      credentialPresent: false,
      ready: false,
      message: `The selected agent provider "${selection.providerId}" is missing or disabled.`,
    };
  }
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

  if (selection) provider = { ...provider, model: selection.model };

  const credential = credentialFor(provider, env, credentials);
  const credentialPresent = credential !== undefined || masterProviderAuth(provider) === "none";
  return {
    provider,
    credential,
    credentialPresent,
    ready: credentialPresent,
    ...(credentialPresent
      ? {}
      : {
          message: `Enter an API key for ${provider.name} in Settings.`,
        }),
  };
}

export function credentialFor(
  provider: MasterProvider,
  env: NodeJS.ProcessEnv = process.env,
  credentials?: ProviderCredentialReader,
): string | undefined {
  if (masterProviderAuth(provider) === "none") return undefined;
  const saved = credentials?.get(provider.id)?.trim();
  if (saved) return saved;
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
  if (provider.protocol === "openai-chat-completions") {
    return createOpenAiChatLlmClient({
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
      provider?.protocol === "openai-responses" || provider?.protocol === "openai-chat-completions"
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
          // Compatibility-only metadata. New credentials are saved from Settings.
          ...(provider.apiKeyEnv ? { credentialEnv: provider.apiKeyEnv } : {}),
        }
      : {}),
    credentialPresent: selected.credentialPresent,
    ready: selected.ready,
    ...(selected.message ? { message: selected.message } : {}),
  };
}
