import { z } from "zod";
import { EntityBaseSchema, IdSchema } from "./common.js";

/** A reusable model/harness profile users can assign to chat or execution work. */
export const AgentHarnessSchema = z.enum(["nexestra", "codex", "opencode"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;

export const AgentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  instructions: z.string().max(20_000).default(""),
  harness: AgentHarnessSchema,
  /** Required only when Nexestra itself is the harness. */
  providerId: IdSchema.optional(),
  /** Optional for CLI harness defaults; required for Nexestra. */
  model: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().default(true),
});

function validateAgent(agent: z.infer<typeof AgentFieldsSchema>, context: z.RefinementCtx): void {
  if (agent.harness === "nexestra" && !agent.providerId) {
    context.addIssue({
      code: "custom",
      path: ["providerId"],
      message: "a Nexestra agent requires a provider",
    });
  }
  if (agent.harness === "nexestra" && !agent.model) {
    context.addIssue({
      code: "custom",
      path: ["model"],
      message: "a Nexestra agent requires a model",
    });
  }
  if (agent.harness !== "nexestra" && agent.providerId) {
    context.addIssue({
      code: "custom",
      path: ["providerId"],
      message: "only a Nexestra agent can select a provider",
    });
  }
}

export const AgentConfigurationSchema = AgentFieldsSchema.superRefine(validateAgent);

export const AgentSchema = EntityBaseSchema.extend(AgentConfigurationSchema.shape).superRefine(
  validateAgent,
);
export type Agent = z.infer<typeof AgentSchema>;
