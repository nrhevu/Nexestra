// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData } from "../../shared/contracts.js";
import { surfaceTemplate, type WorkspaceSurface } from "../../shared/surfaces.js";
import { SurfaceStudio } from "./SurfaceStudio.js";
import { SurfaceView } from "./SurfaceViews.js";

const now = "2026-09-06T18:00:00Z";
const workspace = {
  id: "workspace",
  name: "Product",
  slug: "product",
  createdAt: now,
  updatedAt: now,
};
const data: BootstrapData = {
  workspace,
  workspaces: [workspace],
  threads: [],
  workBriefs: [],
  surfaces: [],
  goals: [],
  agents: [],
  knowledge: [],
  tasks: [],
  assignments: [],
  activeRuns: [],
  runtime: {
    chatgpt: { installed: false, connected: false, message: "offline" },
    harnesses: {
      codex: { installed: false, version: null },
      opencode: { installed: false, version: null },
    },
  },
  workspacePath: "/workspace",
  dataPath: "/workspace/.nexestra",
};
const surface: WorkspaceSurface = {
  id: "788020d3-b419-4e10-871d-6da045e9e7d6",
  workspaceId: workspace.id,
  manifest: surfaceTemplate("canvas", "Ideas"),
  revision: 3,
  enabled: true,
  createdAt: now,
  updatedAt: now,
  updatedBy: { kind: "user", id: "local-user" },
  records: [
    {
      id: "ec9655e3-d877-4527-8655-cb00809c6ac6",
      data: { title: "An idea", notes: "Keep the whole record", source: "https://example.com" },
      color: "blue",
      position: { x: 100, y: 120 },
      revision: 1,
      archived: false,
      updatedAt: now,
      updatedBy: { kind: "user", id: "local-user" },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Surface studio", () => {
  it("creates a whiteboard then saves a positioned note through the shared command", async () => {
    const user = userEvent.setup();
    let current: WorkspaceSurface = { ...surface, records: [] };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      current =
        init.method === "POST" && input.manifest
          ? { ...current, manifest: input.manifest }
          : { ...current, revision: 4, records: [{ ...required(surface.records[0]), ...input }] };
      return new Response(JSON.stringify(current));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SurfaceStudio data={data} onChanged={async () => undefined} />);
    await user.click(screen.getByRole("button", { name: "New surface" }));
    await user.clear(screen.getByLabelText("Surface name"));
    await user.type(screen.getByLabelText("Surface name"), "Launch ideas");
    await user.click(screen.getByRole("button", { name: "Create surface" }));
    await screen.findByRole("heading", { name: "Launch ideas" });
    await user.click(screen.getByRole("button", { name: "Add record" }));
    await user.type(screen.getByLabelText("Title", { exact: true }), "Explain the outcome");
    await user.type(
      screen.getByLabelText("Notes", { exact: true }),
      "Make intent visible before dispatch.",
    );
    await user.selectOptions(screen.getByLabelText("Card color"), "green");
    await user.click(screen.getByText("Position on canvas"));
    await user.clear(screen.getByLabelText("Canvas X"));
    await user.type(screen.getByLabelText("Canvas X"), "280");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Explain the outcome");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toMatchObject({
      expectedRevision: 3,
      data: { title: "Explain the outcome", notes: "Make intent visible before dispatch." },
      position: { x: 280, y: 40 },
      color: "green",
    });
    expect(window.location.search).toContain(surface.id);
  });

  it("keeps unsaved content on a version conflict and sends the complete original record", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            error: {
              message: "This surface changed. Reload the latest version and reconcile your edit.",
            },
          }),
          { status: 409 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SurfaceStudio data={{ ...data, surfaces: [surface] }} onChanged={async () => undefined} />,
    );
    await user.click(screen.getByRole("button", { name: "An idea Keep the whole record" }));
    await user.clear(screen.getByLabelText("Title", { exact: true }));
    await user.type(screen.getByLabelText("Title", { exact: true }), "My draft");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This surface changed");
    expect(screen.getByLabelText("Title", { exact: true })).toHaveValue("My draft");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      expectedRevision: 3,
      id: surface.records[0]?.id,
      data: { title: "My draft", notes: "Keep the whole record", source: "https://example.com" },
      position: { x: 100, y: 120 },
    });
  });

  it("imports a declarative table, rejects executable fields, and retains the import draft", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...surface, manifest: surfaceTemplate("table", "Research matrix") }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SurfaceStudio data={data} onChanged={async () => undefined} />);
    await user.click(screen.getByRole("button", { name: "New surface" }));
    await user.click(screen.getByRole("button", { name: "Import definition" }));
    const input = {
      manifest: { ...surfaceTemplate("table", "Research matrix"), script: "alert(1)" },
      records: [],
    };
    fireEvent.change(screen.getByLabelText("Plugin definition JSON"), {
      target: { value: JSON.stringify(input) },
    });
    await user.click(screen.getByRole("button", { name: "Import surface" }));
    await screen.findByRole("alert");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Plugin definition JSON"), {
      target: {
        value: JSON.stringify({
          manifest: surfaceTemplate("table", "Research matrix"),
          records: [],
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "Import surface" }));
    await screen.findByRole("heading", { name: "Research matrix" });
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("moves a board record without treating a declared Unsorted option as the empty column", async () => {
    const manifest = surfaceTemplate("board", "Decisions");
    const stage = required(manifest.fields.find((field) => field.key === "stage"));
    stage.options = ["Unsorted", "Decided"];
    const board = {
      ...surface,
      manifest,
      records: [{ ...required(surface.records[0]), data: { title: "An idea", stage: "Unsorted" } }],
    };
    const save = vi.fn(async () => undefined);
    render(
      <SurfaceView
        surface={board}
        selection={[]}
        working={false}
        onSelect={() => undefined}
        onEdit={() => undefined}
        onCreate={() => undefined}
        onSave={save}
      />,
    );
    const columns = screen.getAllByRole("region", { name: "Unsorted column" });
    expect(within(required(columns[0])).getByText("An idea")).toBeInTheDocument();
    expect(within(required(columns[1])).queryByText("An idea")).not.toBeInTheDocument();
    fireEvent.drop(screen.getByRole("region", { name: "Decided column" }), {
      dataTransfer: { getData: () => required(board.records[0]).id },
    });
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(board.records[0], {
        data: { title: "An idea", stage: "Decided" },
      }),
    );
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
