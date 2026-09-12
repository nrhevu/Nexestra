// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhiteboardView } from "./WhiteboardView.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WhiteboardView", () => {
  it("loads Markdown and saves edits for the selected workspace", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      response({ workspaceId: "workspace-1", content: "# Existing", updatedAt: null }),
    );
    fetchMock.mockResolvedValueOnce(
      response({
        workspaceId: "workspace-1",
        content: "# Updated",
        updatedAt: "2026-09-12T12:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WhiteboardView workspaceId="workspace-1" />);
    const editor = await screen.findByRole("textbox", { name: "Whiteboard Markdown" });
    expect(editor).toHaveValue("# Existing");
    await userEvent.clear(editor);
    await userEvent.type(editor, "# Updated");
    await userEvent.click(screen.getByRole("button", { name: "Save whiteboard" }));
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeVisible());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/whiteboard?workspaceId=workspace-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ content: "# Updated" }),
      }),
    );
  });

  it("shows a bounded load error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(response({ error: { message: "Unavailable" } }, 503)),
    );
    render(<WhiteboardView workspaceId="workspace-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.getByRole("button", { name: "Save whiteboard" })).toBeDisabled();
  });
});
