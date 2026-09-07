import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreateSurfaceSchema, SurfaceManifestSchema, surfaceTemplate } from "../shared/surfaces.js";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-surfaces-"));
  roots.push(root);
  const store = await FileStore.open({ root, workspacePath: root });
  const surface = await store.createSurface({
    manifest: surfaceTemplate("canvas", "Shared ideas"),
    records: [
      {
        data: { title: "Explore", notes: "A complete note" },
        position: { x: 100, y: 120 },
        color: "blue",
      },
    ],
  });
  return { store, root, surface, record: required(surface.records[0]) };
}

describe("Declarative surfaces", () => {
  it.each(["research-matrix", "decision-canvas"])(
    "imports the documented %s example",
    async (name) => {
      const { store } = await fixture();
      const input = JSON.parse(
        await readFile(
          new URL(`../../docs/examples/surfaces/${name}.json`, import.meta.url),
          "utf8",
        ),
      );
      const surface = await store.createSurface(input);
      expect(surface.manifest.pluginId).toBe(`local.${name}`);
      expect(surface.records.length).toBeGreaterThan(0);
    },
  );
  it("persists records, authors and positions across restarts and exports portable definitions", async () => {
    const { store, root, surface, record } = await fixture();
    const updated = await store.saveSurfaceRecord(surface.id, {
      expectedRevision: 1,
      id: record.id,
      data: { ...record.data, title: "A revised idea" },
    });
    expect(updated.records[0]).toMatchObject({
      revision: 2,
      position: { x: 100, y: 120 },
      color: "blue",
      updatedBy: { kind: "user" },
    });
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.getSurface(surface.id)).toEqual(updated);
    const exported = CreateSurfaceSchema.parse({
      manifest: updated.manifest,
      records: updated.records.map(({ data, position, color }) => ({ data, position, color })),
    });
    const imported = await reopened.createSurface(exported);
    expect(imported.id).not.toBe(surface.id);
    expect(imported.records[0]?.id).not.toBe(record.id);
    expect(imported.records[0]?.data).toEqual(updated.records[0]?.data);
  });

  it("serializes competing edits and preserves saved data when a schema update is incompatible", async () => {
    const { store, surface, record } = await fixture();
    const results = await Promise.allSettled(
      ["One", "Two"].map((title) =>
        store.saveSurfaceRecord(surface.id, {
          expectedRevision: 1,
          id: record.id,
          data: { ...record.data, title },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    const before = store.getSurface(surface.id);
    await expect(
      store.updateSurface(surface.id, {
        expectedRevision: 2,
        manifest: {
          ...surface.manifest,
          fields: surface.manifest.fields.filter((field) => field.key !== "notes"),
          bodyField: undefined,
        },
      }),
    ).rejects.toThrow("Unknown field notes");
    expect(store.getSurface(surface.id)).toEqual(before);
  });

  it("rejects executable definitions, unsafe links, invalid field values and forged metadata", async () => {
    const { store, surface } = await fixture();
    expect(
      SurfaceManifestSchema.safeParse({ ...surface.manifest, script: "alert(1)" }).success,
    ).toBe(false);
    for (const data of [
      { title: "" },
      { title: "Note", unknown: "value" },
      { title: "Note", source: "javascript:alert(1)" },
      { title: "Note", source: "https://user@example.com" },
    ]) {
      await expect(
        store.saveSurfaceRecord(surface.id, { expectedRevision: 1, data }),
      ).rejects.toBeDefined();
    }
    await expect(
      store.saveSurfaceRecord(surface.id, {
        expectedRevision: 1,
        data: { title: "Note" },
        updatedBy: { kind: "user", id: "forged" },
      }),
    ).rejects.toBeDefined();
    const board = surfaceTemplate("board", "Ideas");
    await expect(
      store.createSurface({
        manifest: board,
        records: [{ data: { title: "Idea", stage: "Unknown" } }],
      }),
    ).rejects.toThrow("declared options");
    expect(
      SurfaceManifestSchema.safeParse({ ...board, fields: [...board.fields, board.fields[0]] })
        .success,
    ).toBe(false);
  });

  it("scopes agent writes to their workspace, attributes the author, and gates disabled surfaces", async () => {
    const { store, surface, record } = await fixture();
    const agent = await store.createAgent({
      kind: "worker",
      name: "Writer",
      handle: "writer",
      harness: "codex",
      description: "",
      instructions: "",
    });
    const other = await store.createWorkspace({ name: "Other" });
    const foreign = await store.createSurface({
      workspaceId: other.id,
      manifest: surfaceTemplate("table", "Private notes"),
    });
    await expect(
      store.saveSurfaceRecord(foreign.id, { expectedRevision: 1, data: { title: "No" } }, agent.id),
    ).rejects.toThrow("in its workspace");
    expect(() => store.readSurfaceContext(foreign.id, [], agent.id)).toThrow("in its workspace");
    const changed = await store.saveSurfaceRecord(
      surface.id,
      { expectedRevision: 1, id: record.id, data: record.data },
      agent.id,
    );
    expect(changed.updatedBy).toEqual({ kind: "agent", id: agent.id });
    await store.setSurfaceEnabled(surface.id, { expectedRevision: 2, enabled: false });
    expect(() => store.readSurfaceContext(surface.id, [], agent.id)).toThrow("disabled");
    await expect(
      store.saveSurfaceRecord(surface.id, { expectedRevision: 3, data: { title: "No" } }),
    ).rejects.toThrow("disabled");
    expect(store.readSurfaceContext(surface.id).records).toHaveLength(1);
    await store.setSurfaceEnabled(surface.id, { expectedRevision: 3, enabled: true });
    expect(store.readSurfaceContext(surface.id, [], agent.id).records).toHaveLength(1);
  });

  it("archives without losing data and keeps selected semantic context bounded", async () => {
    const { store, surface, record } = await fixture();
    await store.archiveSurfaceRecord(surface.id, record.id, {
      expectedRevision: 1,
      archived: true,
    });
    expect(store.readSurfaceContext(surface.id).records).toHaveLength(0);
    expect(() => store.readSurfaceContext(surface.id, [record.id])).toThrow("unavailable record");
    await store.archiveSurfaceRecord(surface.id, record.id, {
      expectedRevision: 2,
      archived: false,
    });
    expect(store.getSurface(surface.id)?.records[0]?.data).toEqual(record.data);
    const many = await store.createSurface({
      manifest: surfaceTemplate("document", "Research"),
      records: Array.from({ length: 30 }, (_, index) => ({
        data: { title: `Finding ${index}`, notes: "x".repeat(8000) },
      })),
    });
    const context = store.readSurfaceContext(many.id);
    expect(context.truncated).toBe(true);
    expect(context.records.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(context).length).toBeLessThan(12000);
    const selected = store.readSurfaceContext(many.id, [required(many.records[29]).id]);
    expect(selected.records.map((entry) => entry.data.title)).toEqual(["Finding 29"]);
  });

  it("redacts known credentials before saving text or returning content", async () => {
    const { store, surface } = await fixture();
    const secret = ["fixture", "credential", 'surface"escaped'].join("-");
    await store.createAgent({
      kind: "master",
      name: "Master",
      handle: "master",
      instructions: "",
      description: "",
      provider: {
        type: "custom",
        name: "Test",
        baseUrl: "http://localhost:9876/v1",
        model: "test",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const updated = await store.saveSurfaceRecord(surface.id, {
      expectedRevision: 1,
      data: { title: "Note", notes: `The value is ${secret}` },
    });
    expect(JSON.stringify(updated)).not.toContain(secret);
    expect(updated.records.at(-1)?.data.notes).toBe("The value is [REDACTED]");
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
  });

  it("exposes the shared store commands through the API with conflict and origin checks", async () => {
    const { store, surface, record } = await fixture();
    const app = createApp({
      store,
      runner: {
        invoke: async () => "unused",
        runtimeStatus: async () => ({
          chatgpt: { installed: false, connected: false, message: "offline" },
          harnesses: {
            codex: { installed: false, version: null },
            opencode: { installed: false, version: null },
          },
        }),
      },
    });
    const save = (expectedRevision: number, origin?: string) =>
      app.request(`/api/surfaces/${surface.id}/records`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ expectedRevision, id: record.id, data: { title: "From API" } }),
      });
    expect((await save(1, "https://untrusted.example")).status).toBe(403);
    expect((await save(1)).status).toBe(200);
    expect((await save(1)).status).toBe(409);
    const context = await app.request(`/api/surfaces/${surface.id}/context?ids=${record.id}`);
    expect(await context.json()).toMatchObject({
      revision: 2,
      records: [{ data: { title: "From API" } }],
    });
    const bootstrap = await app.request("/api/bootstrap");
    expect(await bootstrap.json()).toMatchObject({ surfaces: [{ id: surface.id, revision: 2 }] });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
