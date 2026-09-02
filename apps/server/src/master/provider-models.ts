import type { MasterProviderAuth, MasterProviderProtocol, ProviderModelList } from "@nexestra/core";

export interface DiscoverProviderModelsOptions {
  readonly protocol: MasterProviderProtocol;
  readonly baseUrl: string;
  readonly auth: MasterProviderAuth;
  readonly credential?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface ModelListPayload {
  readonly data?: readonly { readonly id?: string }[];
  readonly error?: { readonly message?: string };
}

/** Validate provider credentials and return the model ids exposed by its catalogue. */
export async function discoverProviderModels(
  options: DiscoverProviderModelsOptions,
): Promise<ProviderModelList> {
  if (options.auth === "api-key" && !options.credential?.trim()) {
    throw new Error("Enter an API key before loading models.");
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const anthropic = options.protocol === "anthropic-messages";
  const endpoint = anthropic
    ? `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/models`
    : `${baseUrl}/models`;
  const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
    headers: anthropic
      ? {
          "anthropic-version": "2023-06-01",
          ...(options.credential ? { "x-api-key": options.credential } : {}),
        }
      : options.credential
        ? { authorization: `Bearer ${options.credential}` }
        : {},
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as ModelListPayload | null;
  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Model discovery failed: ${detail}`);
  }
  if (!payload?.data) throw new Error("Model discovery returned an invalid response.");

  const models = [
    ...new Set(payload.data.flatMap((model) => (model.id?.trim() ? [model.id.trim()] : []))),
  ].sort((a, b) => a.localeCompare(b));
  if (models.length === 0) throw new Error("The provider returned no models.");
  return { models };
}
