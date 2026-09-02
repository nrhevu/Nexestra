import { HealthResponseSchema } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const app = createApp();

describe("GET /api/health", () => {
  it("returns ok and a version", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json()).ok).toBe(true);
  });
});

describe("GET /api/mock/*", () => {
  it("lists workspaces", async () => {
    const response = await app.request("/api/mock/workspaces");
    expect(response.status).toBe(200);
    expect(((await response.json()) as unknown[]).length).toBe(1);
  });

  it("filters threads by workspace", async () => {
    const response = await app.request("/api/mock/threads?workspaceId=ws_nexestra");
    expect(((await response.json()) as unknown[]).length).toBe(2);
  });

  it("filters tasks by thread", async () => {
    const response = await app.request("/api/mock/tasks?threadId=th_agent_app");
    expect(((await response.json()) as unknown[]).length).toBe(6);
  });

  it("returns memories and approvals", async () => {
    const memories = await (await app.request("/api/mock/memories")).json();
    const approvals = await (await app.request("/api/mock/approvals")).json();
    expect((memories as unknown[]).length).toBeGreaterThanOrEqual(10);
    expect((approvals as unknown[]).length).toBe(2);
  });

  it("404s an unknown api route", async () => {
    const response = await app.request("/api/mock/nope");
    expect(response.status).toBe(404);
  });
});
