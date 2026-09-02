import type { AppSettingsResponse } from "@nexestra/core";
import {
  AppSettingsSchema,
  CreateMasterProviderRequestSchema,
  masterProviderAuth,
  SaveProviderCredentialRequestSchema,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, body, conflict, required } from "../errors.js";
import { credentialFor } from "../master/llm.js";
import type { ProviderCredentialStore } from "../master/provider-credentials.js";
import type { MasterRunner } from "../master/runner.js";

/**
 * Machine-wide defaults edited from the Settings surface.
 *
 * The response also carries `master`: which model client the process actually
 * will use on its next turn, and whether its server-side credential was found.
 * It rides along here rather
 * than on its own route so the surface can render the truth in one request —
 * and it is read-only; provider configuration itself lives in `AppSettings`.
 */
export function settingsRoutes(
  store: NexestraStore,
  runner: MasterRunner,
  credentials: ProviderCredentialStore,
) {
  const respond = (settings: ReturnType<NexestraStore["getSettings"]>): AppSettingsResponse => {
    const providerCredentials = Object.fromEntries(
      settings.masterProviders.map((provider) => [
        provider.id,
        credentialFor(provider, process.env, credentials) !== undefined,
      ]),
    );
    return { ...settings, master: runner.runtime, providerCredentials };
  };

  return new Hono()
    .get("/", (c) => c.json(respond(store.getSettings())))
    .put("/", async (c) => {
      const settings = store.putSettings(await body(c, AppSettingsSchema.partial()));
      const providerIds = new Set(settings.masterProviders.map((provider) => provider.id));
      credentials.deleteUnknown(providerIds);
      for (const provider of settings.masterProviders) {
        if (masterProviderAuth(provider) === "none") credentials.delete(provider.id);
      }
      return c.json(respond(settings));
    })
    .post("/providers", async (c) => {
      const input = await body(c, CreateMasterProviderRequestSchema);
      const current = store.getSettings();
      if (current.masterProviders.some((provider) => provider.id === input.provider.id)) {
        throw conflict(`Provider id "${input.provider.id}" already exists.`);
      }
      if (input.provider.auth === "api-key" && !input.credential) {
        throw badRequest(`Enter an API key for ${input.provider.name}.`);
      }
      if (input.provider.auth === "none" && input.credential) {
        throw badRequest("A no-auth provider cannot store an API key.");
      }

      if (input.credential) credentials.set(input.provider.id, input.credential);
      try {
        const settings = store.putSettings({
          masterProviders: [...current.masterProviders, input.provider],
          activeMasterProviderId: input.activate
            ? input.provider.id
            : current.activeMasterProviderId,
        });
        return c.json(respond(settings), 201);
      } catch (error) {
        if (input.credential) credentials.delete(input.provider.id);
        throw error;
      }
    })
    .put("/providers/:providerId/credential", async (c) => {
      const provider = required(
        store.getSettings().masterProviders.find((entry) => entry.id === c.req.param("providerId")),
        "provider",
      );
      if (masterProviderAuth(provider) !== "api-key") {
        throw badRequest(`${provider.name} is configured without authentication`);
      }
      const input = await body(c, SaveProviderCredentialRequestSchema);
      credentials.set(provider.id, input.credential);
      return c.json(respond(store.getSettings()));
    })
    .delete("/providers/:providerId/credential", (c) => {
      const provider = required(
        store.getSettings().masterProviders.find((entry) => entry.id === c.req.param("providerId")),
        "provider",
      );
      credentials.delete(provider.id);
      return c.json(respond(store.getSettings()));
    });
}
