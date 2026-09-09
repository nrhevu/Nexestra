// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  OBJECT_URL_CLEANUP_DELAY_MS,
  readCappedBlob,
  safeExportFilename,
  WORKSPACE_EXPORT_UI_DEADLINE_MS,
  WorkspaceExportDialog,
  type WorkspaceExportDialogProps,
} from "./WorkspaceExportDialog.js";

const zipBody = "PK\u0003\u0004 archive bytes";

function zipResponse(overrides: Record<string, string> = {}): Response {
  const size = new TextEncoder().encode(zipBody).length;
  return new Response(zipBody, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(size),
      ...overrides,
    },
  });
}

function jsonErrorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stubObjectUrl() {
  let next = 0;
  const createObjectURL = vi.fn((_blob: Blob) => `blob:mock-${++next}`);
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

function stubAnchorClick() {
  let clicked: HTMLAnchorElement | null = null;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = this;
  });
  return {
    click,
    get clicked() {
      return clicked;
    },
  };
}

function renderDialog(overrides: Partial<WorkspaceExportDialogProps> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <WorkspaceExportDialog
      workspace={{ id: "ws-1", name: "Alpha" }}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...utils, onClose };
}

const click = (element: HTMLElement) => {
  act(() => {
    element.click();
  });
};

function requestInit(mock: ReturnType<typeof vi.fn>, index: number): RequestInit | undefined {
  const call = mock.mock.calls[index];
  return Array.isArray(call) ? (call[1] as RequestInit | undefined) : undefined;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleFakeTimers() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("safeExportFilename", () => {
  it("accepts an ascii filename from a plain filename parameter", () => {
    expect(safeExportFilename('attachment; filename="alpha-export.zip"')).toBe("alpha-export.zip");
  });

  it("falls back for path traversal, non-ascii, or filename* headers", () => {
    expect(safeExportFilename('attachment; filename="../secret.zip"')).toBe("nexestra-export.zip");
    expect(safeExportFilename('attachment; filename="data a.zip"')).toBe("nexestra-export.zip");
    expect(safeExportFilename("attachment; filename*=UTF-8''alpha%2Ezip")).toBe(
      "nexestra-export.zip",
    );
    expect(safeExportFilename(null)).toBe("nexestra-export.zip");
    expect(safeExportFilename(null, "custom.zip")).toBe("custom.zip");
  });
});

describe("readCappedBlob", () => {
  it("streams chunks into one blob", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
    });
    const never = new Promise<never>(() => {});
    const blob = await readCappedBlob(
      body,
      () => Promise.reject(new Error("unused")),
      10,
      never,
      "application/zip",
    );
    expect(blob.size).toBe(6);
    expect(blob.type).toBe("application/zip");
  });

  it("rejects as soon as a chunk crosses the cap", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcdef"));
        controller.close();
      },
    });
    const never = new Promise<never>(() => {});
    await expect(
      readCappedBlob(body, () => Promise.reject(new Error("unused")), 4, never, "application/zip"),
    ).rejects.toThrow("larger than 4 bytes");
  });

  it("defers to the blob fallback when no stream is exposed", async () => {
    const fallback = vi.fn(async () => new Blob([zipBody], { type: "application/zip" }));
    const never = new Promise<never>(() => {});
    const blob = await readCappedBlob(null, fallback, 100, never, "application/zip");
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe("application/zip");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceExportDialog", () => {
  it("downloads the captured workspace only after an explicit click", async () => {
    const urls = stubObjectUrl();
    const anchor = stubAnchorClick();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      zipResponse({ "content-disposition": 'attachment; filename="alpha.zip"' }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderDialog({ workspace: { id: "ws 1", name: "Alpha" } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Export workspace" })).toBeInTheDocument();
    expect(screen.getByText(/SHA-256 manifest/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be imported|importing or restoring/i)).toBeInTheDocument();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const init = requestInit(fetchMock, 0);
    expect(url).toBe(`/api/workspaces/${encodeURIComponent("ws 1")}/export`);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(urls.createObjectURL.mock.calls[0]?.[0]).toMatchObject({
      size: expect.any(Number),
      type: "application/zip",
    });
    expect(anchor.clicked?.download).toBe("alpha.zip");
    expect(anchor.clicked?.href).toMatch(/^blob:mock-/);
  });

  it("coalesces duplicate clicks while one request is pending", async () => {
    const urls = stubObjectUrl();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    click(screen.getByRole("button", { name: "Preparing export…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(zipResponse());
    });
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("discards a delayed network response after a workspace change", async () => {
    const urls = stubObjectUrl();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes("ws-2") ? second.promise : first.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByRole("button", { name: "Cancel export" })).toBeInTheDocument();
    rerender(<WorkspaceExportDialog workspace={{ id: "ws-2", name: "Beta" }} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeEnabled();
    expect(requestInit(fetchMock, 0)?.signal?.aborted).toBe(true);

    await act(async () => {
      first.resolve(zipResponse());
    });
    await flush();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    await act(async () => {
      second.resolve(zipResponse({ "content-disposition": 'attachment; filename="beta.zip"' }));
    });
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Workspace:")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discards a delayed network response or blob after unmount", async () => {
    const urls = stubObjectUrl();

    const network = deferred<Response>();
    const networkFetch = vi.fn(() => network.promise);
    vi.stubGlobal("fetch", networkFetch);
    const first = renderDialog();
    click(screen.getByRole("button", { name: "Download ZIP" }));
    first.unmount();
    await act(async () => {
      network.resolve(zipResponse());
    });
    await flush();
    expect(urls.createObjectURL).not.toHaveBeenCalled();

    const blobGate = deferred<Blob>();
    const blobResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/zip" }),
      blob: () => blobGate.promise,
    } as unknown as Response;
    const blobFetch = vi.fn(async () => blobResponse);
    vi.stubGlobal("fetch", blobFetch);
    const second = renderDialog();
    click(screen.getByRole("button", { name: "Download ZIP" }));
    await screen.findByRole("button", { name: "Cancel export" });
    second.unmount();
    await act(async () => {
      blobGate.resolve(new Blob([zipBody], { type: "application/zip" }));
    });
    await flush();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("cancels the busy attempt and allows a fresh attempt", async () => {
    const urls = stubObjectUrl();
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByRole("button", { name: "Cancel export" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preparing export…" })).toBeDisabled();
    click(screen.getByRole("button", { name: "Cancel export" }));

    expect(requestInit(fetchMock, 0)?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Download ZIP" })).toBeEnabled();
    await act(async () => {
      pending.resolve(zipResponse());
    });
    await flush();
    expect(urls.createObjectURL).not.toHaveBeenCalled();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("times out after 45 seconds even when the network ignores abort", async () => {
    vi.useFakeTimers();
    const urls = stubObjectUrl();
    const never = new Promise<Response>(() => {});
    const fetchMock = vi.fn(() => never);
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_EXPORT_UI_DEADLINE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Export timed out after 45 seconds");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(urls.createObjectURL).not.toHaveBeenCalled();

    vi.useRealTimers();
    fetchMock.mockResolvedValue(zipResponse());
    click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("times out while the HTTP error JSON body hangs", async () => {
    vi.useFakeTimers();
    const urls = stubObjectUrl();
    const errorResponse = jsonErrorResponse("Archive failed.") as unknown as {
      ok: boolean;
      status: number;
      headers: Headers;
      json: () => Promise<never>;
    };
    errorResponse.json = () => new Promise<never>(() => {});
    const fetchMock = vi.fn(async () => errorResponse);
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_EXPORT_UI_DEADLINE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Export timed out after 45 seconds");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not label a later HTTP error as a timeout after a previous timeout", async () => {
    vi.useFakeTimers();
    const urls = stubObjectUrl();
    let reads = 0;
    const fetchMock = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? new Promise<never>(() => {}) : jsonErrorResponse("Archive failed.");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_EXPORT_UI_DEADLINE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Export timed out after 45 seconds");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    vi.useRealTimers();
    click(screen.getByRole("button", { name: "Retry" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Archive failed.");
    expect(alert).not.toHaveTextContent("Export timed out");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects a non-zip content type without rendering the payload as HTML", async () => {
    const urls = stubObjectUrl();
    const fetchMock = vi.fn(
      async () =>
        new Response("<html><body>not the exported UI</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export response was not a ZIP archive.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("not the exported UI");
  });

  it("rejects an oversized content-length before reading the blob", async () => {
    const urls = stubObjectUrl();
    const blobRead = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-type": "application/zip",
            "content-length": String(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1),
          }),
          blob: blobRead,
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export is larger than 136 MiB");
    expect(blobRead).not.toHaveBeenCalled();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects an actual blob over the archive cap when headers understate it", async () => {
    const urls = stubObjectUrl();
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/zip" }),
          blob: async () => ({
            size: WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1,
            type: "application/zip",
          }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export is larger than 136 MiB");
    expect(urls.createObjectURL).not.toHaveBeenCalled();
  });

  it("shows the API error message and retries without autonomous retries", async () => {
    const urls = stubObjectUrl();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonErrorResponse("Archive failed."))
      .mockResolvedValue(zipResponse());
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Archive failed.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after the capture window and on unmount", async () => {
    vi.useFakeTimers();
    const urls = stubObjectUrl();
    const fetchMock = vi.fn(async () => zipResponse());
    vi.stubGlobal("fetch", fetchMock);
    const first = renderDialog();

    click(screen.getByRole("button", { name: "Download ZIP" }));
    await settleFakeTimers();
    expect(screen.getByText("Download started.")).toBeInTheDocument();
    const firstUrl = urls.createObjectURL.mock.results[0]?.value ?? "";
    expect(urls.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(OBJECT_URL_CLEANUP_DELAY_MS);
    });
    expect(urls.revokeObjectURL).toHaveBeenCalledWith(firstUrl);

    first.unmount();
    const second = renderDialog();
    click(screen.getByRole("button", { name: "Download ZIP" }));
    await settleFakeTimers();
    expect(screen.getByText("Download started.")).toBeInTheDocument();
    const secondUrl = urls.createObjectURL.mock.results[1]?.value ?? "";
    second.unmount();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith(secondUrl);
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("focuses the primary action, traps Tab, and closes on Escape", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "outside trigger";
    document.body.append(trigger);
    trigger.focus();
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    expect(screen.getByRole("button", { name: "Download ZIP" })).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close" });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Download ZIP" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never autostarts and starts exactly one request under StrictMode", async () => {
    const urls = stubObjectUrl();
    const fetchMock = vi.fn(async () => zipResponse());
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(
      <StrictMode>
        <WorkspaceExportDialog workspace={{ id: "ws-1", name: "Alpha" }} onClose={onClose} />
      </StrictMode>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    click(screen.getByRole("button", { name: "Download ZIP" }));
    expect(await screen.findByText("Download started.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
