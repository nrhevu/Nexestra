import { AppSettingsSchema } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { createMasterLlm, resolveProvider } from "./llm.js";

describe("Master provider resolution", () => {
  it("selects an enabled provider with a server-side credential", () => {
    const settings = AppSettingsSchema.parse({});
    const selected = resolveProvider(settings, { OPENAI_API_KEY: "secret" });

    expect(selected.provider?.id).toBe("openai");
    expect(selected.credentialPresent).toBe(true);
    expect(selected.ready).toBe(true);
  });

  it("reports an explicitly selected provider as unready when its key is missing", () => {
    const settings = AppSettingsSchema.parse({ activeMasterProviderId: "openai" });
    const runtime = createMasterLlm({ settings: () => settings, env: {} });

    expect(runtime.info()).toEqual(
      expect.objectContaining({
        client: "openai",
        providerId: "openai",
        credentialEnv: "OPENAI_API_KEY",
        credentialPresent: false,
        ready: false,
      }),
    );
    expect(runtime.info().message).toBe("Enter an API key for OpenAI in Settings.");
  });

  it("prefers the credential saved from Settings over the environment fallback", () => {
    const settings = AppSettingsSchema.parse({ activeMasterProviderId: "openai" });
    const selected = resolveProvider(
      settings,
      { OPENAI_API_KEY: "environment-secret" },
      {
        get: () => "saved-secret",
      },
    );

    expect(selected.credential).toBe("saved-secret");
    expect(selected.ready).toBe(true);
  });

  it("uses a thread agent's provider and model instead of the global selection", () => {
    const settings = AppSettingsSchema.parse({
      activeMasterProviderId: "openai",
      masterProviders: [
        {
          id: "openai",
          name: "OpenAI",
          protocol: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          model: "global-model",
          auth: "api-key",
        },
      ],
    });
    const selected = resolveProvider(
      settings,
      {},
      { get: () => "secret" },
      {
        providerId: "openai",
        model: "agent-model",
      },
    );

    expect(selected.provider?.model).toBe("agent-model");
    expect(selected.ready).toBe(true);
  });

  it("supports a custom loopback Responses provider without a credential", async () => {
    let called = "";
    const settings = AppSettingsSchema.parse({
      activeMasterProviderId: "local-model",
      masterProviders: [
        {
          id: "local-model",
          name: "Local model",
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "local-master",
          auth: "none",
        },
      ],
    });
    const runtime = createMasterLlm({
      settings: () => settings,
      env: {},
      fetch: async (input) => {
        called = String(input);
        return new Response(
          JSON.stringify({
            id: "resp_local",
            model: "local-master",
            output: [{ type: "message", content: [{ type: "output_text", text: "ready" }] }],
          }),
        );
      },
    });

    expect(runtime.info().ready).toBe(true);
    for await (const _event of runtime.client.stream({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      effort: "medium",
      maxTokens: 128,
    })) {
      // Consume the response so the request is made.
    }
    expect(called).toBe("http://127.0.0.1:8080/v1/responses");
  });

  it("rejects insecure remote provider URLs", () => {
    expect(() =>
      AppSettingsSchema.parse({
        masterProviders: [
          {
            id: "insecure",
            name: "Insecure",
            protocol: "openai-responses",
            baseUrl: "http://models.example/v1",
            model: "model",
          },
        ],
      }),
    ).toThrow("provider URLs must use HTTPS");
  });
});
