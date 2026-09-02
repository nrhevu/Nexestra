import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderCredentialStore } from "./provider-credentials.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function credentialFile(): string {
  const home = mkdtempSync(join(tmpdir(), "nexestra-credentials-"));
  homes.push(home);
  return join(home, "credentials.json");
}

describe("ProviderCredentialStore", () => {
  it("persists, replaces and removes provider credentials", () => {
    const file = credentialFile();
    const store = new ProviderCredentialStore(file);

    store.set("openai", " first-secret ");
    expect(store.get("openai")).toBe("first-secret");
    expect(new ProviderCredentialStore(file).get("openai")).toBe("first-secret");

    store.set("openai", "replacement-secret");
    expect(new ProviderCredentialStore(file).get("openai")).toBe("replacement-secret");

    store.delete("openai");
    expect(new ProviderCredentialStore(file).has("openai")).toBe(false);
  });

  it("writes a current-user-only file", () => {
    const file = credentialFile();
    new ProviderCredentialStore(file).set("anthropic", "secret");

    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("does not silently replace an invalid credential file", () => {
    const file = credentialFile();
    writeFileSync(file, "not json", { mode: 0o600 });

    expect(() => new ProviderCredentialStore(file)).toThrow("Cannot read provider credentials");
    expect(readFileSync(file, "utf8")).toBe("not json");
  });
});
