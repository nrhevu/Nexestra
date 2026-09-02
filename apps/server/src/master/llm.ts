/**
 * Which model the Master runs on.
 *
 * `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) present → the real Opus 5
 * client. Otherwise the deterministic `DemoLlmClient`, so a fresh checkout is
 * still a usable application rather than a chat box that errors. Override with
 * `NEXESTRA_MASTER_LLM=demo|anthropic`.
 *
 * The choice is reported at `GET /api/health` and `GET /api/settings` as a
 * `MasterRuntimeInfo`, which says whether a key is present but never what it
 * is.
 */
import type { MasterRuntimeInfo } from "@nexestra/core";
import type { LlmClient } from "@nexestra/master";
import { createAnthropicLlmClient, hasAnthropicCredentials, MASTER_MODEL } from "@nexestra/master";
import { createDemoLlmClient, DEMO_MODEL } from "./demo-llm.js";

export interface MasterLlmRuntime {
  readonly client: LlmClient;
  readonly info: MasterRuntimeInfo;
}

export function createMasterLlm(env: NodeJS.ProcessEnv = process.env): MasterLlmRuntime {
  const apiKeyPresent = hasAnthropicCredentials(env);
  const requested = env.NEXESTRA_MASTER_LLM;
  const useAnthropic = requested === "anthropic" || (requested !== "demo" && apiKeyPresent);

  if (useAnthropic) {
    return {
      client: createAnthropicLlmClient(),
      info: { client: "anthropic", model: MASTER_MODEL, apiKeyPresent },
    };
  }

  return {
    client: createDemoLlmClient(),
    info: { client: "demo", model: DEMO_MODEL, apiKeyPresent },
  };
}
