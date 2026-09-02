import { AgentSchema, CreateAgentRequestSchema, UpdateAgentRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, body, conflict, required, requireQuery } from "../errors.js";

export function agentRoutes(store: NexestraStore) {
  const validateProvider = (agent: { harness: string; providerId?: string }): void => {
    if (agent.harness !== "nexestra") return;
    const provider = store
      .getSettings()
      .masterProviders.find((entry) => entry.id === agent.providerId && entry.enabled);
    if (!provider) throw badRequest("Select an enabled Master provider for this Nexestra agent.");
  };

  return new Hono()
    .get("/", (c) => {
      const workspaceId = requireQuery(c, "workspaceId");
      required(store.getWorkspace(workspaceId), "workspace");
      return c.json(store.listAgents(workspaceId));
    })
    .post("/", async (c) => {
      const input = await body(c, CreateAgentRequestSchema);
      required(store.getWorkspace(input.workspaceId), "workspace");
      validateProvider(input);
      return c.json(store.createAgent(input), 201);
    })
    .patch("/:agentId", async (c) => {
      const current = required(store.getAgent(c.req.param("agentId")), "agent");
      const patch = await body(c, UpdateAgentRequestSchema);
      const candidate = AgentSchema.safeParse({ ...current, ...patch });
      if (!candidate.success) {
        throw badRequest("agent configuration failed validation", candidate.error);
      }
      validateProvider(candidate.data);
      return c.json(store.updateAgent(current.id, patch));
    })
    .delete("/:agentId", (c) => {
      const agent = required(store.getAgent(c.req.param("agentId")), "agent");
      const usedByThread = store
        .listThreads(agent.workspaceId)
        .some((thread) => thread.agentId === agent.id);
      const usedByTask = store
        .listThreads(agent.workspaceId)
        .some((thread) => store.listTasks(thread.id).some((task) => task.agentId === agent.id));
      if (usedByThread || usedByTask) {
        throw conflict("Agent is still assigned. Reassign it before deleting.");
      }
      store.deleteAgent(agent.id);
      return c.body(null, 204);
    });
}
