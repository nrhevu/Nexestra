import { describe, expect, it } from "vitest";
import { masterProviderAuth, MasterProviderSchema } from "./settings.js";

const provider = {
  id: "custom",
  name: "Custom",
  protocol: "openai-responses" as const,
  model: "model-1",
  enabled: true,
};

describe("MasterProviderSchema", () => {
  it.each([
    "https://models.example.com/v1",
    "http://127.0.0.1:8080/v1",
    "http://localhost:8080/v1",
    "http://[::1]:8080/v1",
  ])("accepts safe provider URL %s", (baseUrl) => {
    expect(MasterProviderSchema.parse({ ...provider, baseUrl }).baseUrl).toBe(baseUrl);
  });

  it.each([
    "http://models.example.com/v1",
    "https://token@models.example.com/v1",
    "https://models.example.com/v1?token=secret",
    "https://models.example.com/v1#secret",
  ])("rejects unsafe provider URL %s", (baseUrl) => {
    expect(MasterProviderSchema.safeParse({ ...provider, baseUrl }).success).toBe(false);
  });

  it("keeps legacy provider auth compatible", () => {
    const withEnvironment = MasterProviderSchema.parse({
      ...provider,
      id: "legacy",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "LEGACY_API_KEY",
    });
    const local = MasterProviderSchema.parse({
      ...provider,
      id: "local",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    expect(masterProviderAuth(withEnvironment)).toBe("api-key");
    expect(masterProviderAuth(local)).toBe("none");
  });
});
