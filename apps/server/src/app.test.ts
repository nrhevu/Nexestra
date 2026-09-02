import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApiError,
  ApprovalSchema,
  HealthResponseSchema,
  MemorySchema,
  MessageSchema,
  TaskSchema,
  ThreadSchema,
  WorkspaceSchema,
} from "@nexestra/core";
import { createStore, type NexestraStore, seedMock } from "@nexestra/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

let home: string;
let store: NexestraStore;
let app: ReturnType<typeof createApp>;

const WORKSPACE = "ws_nexestra";
const THREAD = "th_agent_app";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nexestra-server-"));
  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
  seedMock(store);
  app = createApp(store);
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const get = (path: string) => app.request(path);

const send = (path: string, method: string, payload?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/** A directory that passes `resolveWorkspacePath`, without shelling out to git. */
async function fakeRepository(name: string): Promise<string> {
  const root = join(home, name);
  await mkdir(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/trunk\n");
  return root;
}

describe("GET /api/health", () => {
  it("returns ok and a version", async () => {
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json()).version).toBe("0.0.0-m1");
  });
});

describe("workspaces", () => {
  it("lists the seeded workspace", async () => {
    const rows = WorkspaceSchema.array().parse(await (await get("/api/workspaces")).json());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(WORKSPACE);
  });

  it("creates a workspace from a git repository path", async () => {
    const root = await fakeRepository("repo");
    const response = await send("/api/workspaces", "POST", { path: root });
    expect(response.status).toBe(201);

    const workspace = WorkspaceSchema.parse(await response.json());
    expect(workspace.rootPath).toBe(root);
    expect(workspace.name).toBe("repo");
    expect(workspace.defaultBranch).toBe("trunk");
    expect(store.listWorkspaces()).toHaveLength(2);
  });

  it("rejects a directory that is not a git repository", async () => {
    const root = join(home, "plain");
    await mkdir(root, { recursive: true });

    const response = await send("/api/workspaces", "POST", { path: root });
    expect(response.status).toBe(400);
    const error = (await response.json()) as ApiError;
    expect(error.error.code).toBe("invalid_workspace_path");
    expect(error.error.message).toContain("not a git repository");
  });

  it("rejects a path that does not exist", async () => {
    const response = await send("/api/workspaces", "POST", { path: join(home, "missing") });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.message).toContain("no such directory");
  });

  it("rejects a body that fails validation", async () => {
    const response = await send("/api/workspaces", "POST", { notAPath: 1 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("bad_request");
  });
});

describe("threads and messages", () => {
  it("filters threads by workspace", async () => {
    const rows = ThreadSchema.array().parse(
      await (await get(`/api/threads?workspaceId=${WORKSPACE}`)).json(),
    );
    expect(rows).toHaveLength(2);
  });

  it("creates a thread and updates its phase", async () => {
    const created = ThreadSchema.parse(
      await (
        await send("/api/threads", "POST", { workspaceId: WORKSPACE, title: "New idea" })
      ).json(),
    );
    expect(created.phase).toBe("intake");

    const updated = ThreadSchema.parse(
      await (await send(`/api/threads/${created.id}`, "PATCH", { phase: "clarifying" })).json(),
    );
    expect(updated.phase).toBe("clarifying");
    expect(store.getThread(created.id)?.phase).toBe("clarifying");
  });

  it("stores a message posted to a thread", async () => {
    const before = store.listMessages(THREAD).length;
    const response = await send(`/api/threads/${THREAD}/messages`, "POST", {
      content: "please also add a CLI",
    });
    expect(response.status).toBe(201);

    const message = MessageSchema.parse(await response.json());
    expect(message.role).toBe("user");
    expect(store.listMessages(THREAD)).toHaveLength(before + 1);
  });

  it("returns the spec and the plan of a thread", async () => {
    const spec = (await (await get(`/api/threads/${THREAD}/spec`)).json()) as { version: number };
    expect(spec.version).toBe(3);
    const plan = (await (await get(`/api/threads/${THREAD}/plan`)).json()) as { taskIds: string[] };
    expect(plan.taskIds.length).toBeGreaterThan(0);
  });

  it("404s an unknown thread", async () => {
    const response = await get("/api/threads/nope");
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error.code).toBe("not_found");
  });
});

describe("tasks", () => {
  it("lists tasks of a thread", async () => {
    const rows = TaskSchema.array().parse(
      await (await get(`/api/tasks?threadId=${THREAD}`)).json(),
    );
    expect(rows).toHaveLength(6);
  });

  it("requires threadId", async () => {
    const response = await get("/api/tasks");
    expect(response.status).toBe(400);
  });

  it("persists a status change from a board drag", async () => {
    const [task] = store.listTasks(THREAD);
    const updated = TaskSchema.parse(
      await (await send(`/api/tasks/${task?.id}/status`, "POST", { status: "review" })).json(),
    );
    expect(updated.status).toBe("review");
    expect(store.getTask(task?.id ?? "")?.status).toBe("review");
  });

  it("persists an edit from the sidebar", async () => {
    const [task] = store.listTasks(THREAD);
    const updated = TaskSchema.parse(
      await (
        await send(`/api/tasks/${task?.id}`, "PATCH", {
          title: "Renamed",
          assignedHarness: "opencode",
        })
      ).json(),
    );
    expect(updated.title).toBe("Renamed");
    expect(updated.assignedHarness).toBe("opencode");
  });

  it("persists a reorder", async () => {
    const ids = store.listTasks(THREAD).map((task) => task.id);
    const reversed = [...ids].reverse();
    const rows = TaskSchema.array().parse(
      await (
        await send("/api/tasks/reorder", "POST", { threadId: THREAD, taskIds: reversed })
      ).json(),
    );
    expect(rows.map((task) => task.id)).toEqual(reversed);
  });
});

describe("runs and artifacts", () => {
  it("lists runs and their events", async () => {
    const runs = (await (await get(`/api/runs?threadId=${THREAD}`)).json()) as Array<{
      id: string;
    }>;
    expect(runs.length).toBeGreaterThan(0);

    const events = (await (await get("/api/runs/run_opencode_1/events")).json()) as unknown[];
    expect(events).toHaveLength(5);
  });

  it("falls back to the preview when the artifact has no bytes on disk", async () => {
    const [artifact] = store.listArtifacts(THREAD);
    const content = (await (await get(`/api/artifacts/${artifact?.id}/content`)).json()) as {
      source: string;
      content: string;
    };
    expect(content.source).toBe("preview");
    expect(content.content).toBe(artifact?.preview);
  });
});

describe("approvals", () => {
  it("resolves a pending approval once", async () => {
    const [approval] = store.listApprovals({ workspaceId: WORKSPACE, status: "pending" });
    const resolved = ApprovalSchema.parse(
      await (
        await send(`/api/approvals/${approval?.id}/resolve`, "POST", { status: "approved" })
      ).json(),
    );
    expect(resolved.status).toBe("approved");

    const again = await send(`/api/approvals/${approval?.id}/resolve`, "POST", {
      status: "rejected",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiError).error.code).toBe("conflict");
  });
});

describe("memories", () => {
  it("creates, edits, links and deletes a memory", async () => {
    const created = MemorySchema.parse(
      await (
        await send("/api/memories", "POST", {
          workspaceId: WORKSPACE,
          threadId: THREAD,
          type: "lesson",
          title: "Seeded lesson",
        })
      ).json(),
    );
    expect(created.authoredBy).toBe("user");

    const edited = MemorySchema.parse(
      await (await send(`/api/memories/${created.id}`, "PATCH", { content: "edited" })).json(),
    );
    expect(edited.content).toBe("edited");
    expect(edited.title).toBe("Seeded lesson");

    const linked = MemorySchema.parse(
      await (
        await send(`/api/memories/${created.id}/links`, "POST", {
          targetId: "mem_goal",
          type: "derives_from",
        })
      ).json(),
    );
    expect(linked.links).toHaveLength(1);

    expect((await send(`/api/memories/${created.id}`, "DELETE")).status).toBe(204);
    expect(store.getMemory(created.id)).toBeNull();
  });
});

describe("settings", () => {
  it("reads and writes machine-wide settings", async () => {
    const before = (await (await get("/api/settings")).json()) as { concurrency: number };
    expect(before.concurrency).toBe(2);

    const after = (await (await send("/api/settings", "PUT", { concurrency: 5 })).json()) as {
      concurrency: number;
      defaultHarness: string;
    };
    expect(after.concurrency).toBe(5);
    expect(after.defaultHarness).toBe("codex");
    expect(store.getSettings().concurrency).toBe(5);
  });

  it("activates a persisted custom Master provider without a restart", async () => {
    const response = await send("/api/settings", "PUT", {
      activeMasterProviderId: "local-master",
      masterProviders: [
        {
          id: "local-master",
          name: "Local Master",
          protocol: "openai-responses",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "planner",
          enabled: true,
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        activeMasterProviderId: "local-master",
        master: expect.objectContaining({
          providerId: "local-master",
          model: "planner",
          ready: true,
        }),
      }),
    );
  });

  it("saves a provider credential from Settings without returning it", async () => {
    await send("/api/settings", "PUT", {
      activeMasterProviderId: "custom-master",
      masterProviders: [
        {
          id: "custom-master",
          name: "Custom Master",
          protocol: "openai-responses",
          baseUrl: "https://models.example/v1",
          model: "planner",
          auth: "api-key",
          enabled: true,
        },
      ],
    });

    const saved = await send("/api/settings/providers/custom-master/credential", "PUT", {
      credential: "top-secret-provider-key",
    });
    expect(saved.status).toBe(200);
    const payload = (await saved.json()) as {
      master: { ready: boolean };
      providerCredentials: Record<string, boolean>;
    };
    expect(payload.master.ready).toBe(true);
    expect(payload.providerCredentials["custom-master"]).toBe(true);

    const publicResponse = JSON.stringify(await (await get("/api/settings")).json());
    expect(publicResponse).not.toContain("top-secret-provider-key");
    expect(JSON.stringify(store.getSettings())).not.toContain("top-secret-provider-key");

    const file = join(home, "credentials.json");
    expect(readFileSync(file, "utf8")).toContain("top-secret-provider-key");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const removed = await send("/api/settings/providers/custom-master/credential", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual(
      expect.objectContaining({
        master: expect.objectContaining({ ready: false }),
        providerCredentials: { "custom-master": false },
      }),
    );
  });

  it("creates and activates a custom provider with its credential in one request", async () => {
    const response = await send("/api/settings/providers", "POST", {
      provider: {
        id: "openrouter",
        name: "OpenRouter",
        protocol: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5.6",
        auth: "api-key",
        enabled: true,
      },
      credential: "custom-provider-secret",
      activate: true,
    });

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("custom-provider-secret");
    expect(JSON.parse(text)).toEqual(
      expect.objectContaining({
        activeMasterProviderId: "openrouter",
        providerCredentials: expect.objectContaining({ openrouter: true }),
        master: expect.objectContaining({ providerId: "openrouter", ready: true }),
      }),
    );
    expect(store.getSettings().masterProviders).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "openrouter" })]),
    );
  });

  it("discovers selectable models without returning the credential", async () => {
    let authorization: string | null = null;
    app = createApp(store, {
      providerFetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] });
      },
    });
    const response = await send("/api/settings/providers/discover-models", "POST", {
      protocol: "openai-chat-completions",
      baseUrl: "https://models.example/v1",
      auth: "api-key",
      credential: "discovery-secret",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ["model-a", "model-b"] });
    expect(authorization).toBe("Bearer discovery-secret");
  });

  it("rejects duplicate, missing-key and contradictory custom providers", async () => {
    const provider = {
      id: "custom-master",
      name: "Custom Master",
      protocol: "openai-responses",
      baseUrl: "https://models.example/v1",
      model: "planner",
      auth: "api-key",
      enabled: true,
    };

    expect((await send("/api/settings/providers", "POST", { provider })).status).toBe(400);
    expect(
      (
        await send("/api/settings/providers", "POST", {
          provider: { ...provider, id: "openai" },
          credential: "secret",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send("/api/settings/providers", "POST", {
          provider: { ...provider, id: "local", auth: "none" },
          credential: "unused-secret",
        })
      ).status,
    ).toBe(400);
  });
});

describe("events", () => {
  it("exposes a thread's log and honours afterSeq", async () => {
    const all = (await (await get(`/api/threads/${THREAD}/events`)).json()) as Array<{
      seq: number;
    }>;
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]?.seq).toBe(0);

    const tail = (await (
      await get(`/api/threads/${THREAD}/events?afterSeq=0`)
    ).json()) as unknown[];
    expect(tail).toHaveLength(all.length - 1);
  });
});

describe("unknown routes", () => {
  it("404s with the error envelope", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error.code).toBe("not_found");
  });
});
