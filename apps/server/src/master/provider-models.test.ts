import { describe, expect, it } from "vitest";
import { discoverProviderModels } from "./provider-models.js";

describe("provider model discovery", () => {
  it("loads and sorts OpenAI-compatible models with bearer auth", async () => {
    let url = "";
    let authorization: string | null = null;
    const result = await discoverProviderModels({
      protocol: "openai-chat-completions",
      baseUrl: "https://models.example/v1/",
      auth: "api-key",
      credential: "secret",
      fetch: async (input, init) => {
        url = String(input);
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ data: [{ id: "z-model" }, { id: "a-model" }] });
      },
    });

    expect(url).toBe("https://models.example/v1/models");
    expect(authorization).toBe("Bearer secret");
    expect(result.models).toEqual(["a-model", "z-model"]);
  });

  it("uses Anthropic's v1 catalogue and headers", async () => {
    let url = "";
    let headers = new Headers();
    await discoverProviderModels({
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: "api-key",
      credential: "secret",
      fetch: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        return Response.json({ data: [{ id: "claude-opus-5" }] });
      },
    });
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });
});
