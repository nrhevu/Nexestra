// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  type WorkspaceExportEntry,
  type WorkspaceExportManifest,
} from "../shared/contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE,
  type WorkspaceArchiveInspectionReport,
} from "../shared/workspace-archive-inspection-contracts.js";
import {
  WorkspaceArchiveInspectionDialog,
  type WorkspaceArchiveInspectionDialogProps,
} from "./WorkspaceArchiveInspectionDialog.js";
import { inspectArchiveInWorker } from "./workspace-archive-inspection-client.js";

vi.mock("./workspace-archive-inspection-client.js", () => ({
  inspectArchiveInWorker: vi.fn(),
}));

const inspectMock = vi.mocked(inspectArchiveInWorker);

function entry(path: string, overrides: Partial<WorkspaceExportEntry> = {}): WorkspaceExportEntry {
  return {
    path,
    kind: "upload",
    bytes: 1024,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function manifest(entries: WorkspaceExportEntry[]): WorkspaceExportManifest {
  return {
    format: "nexestra.workspace-export",
    version: 1,
    createdAt: "2026-09-09T13:00:00.000Z",
    workspace: { id: "ws-archive", name: "Archived Alpha" },
    stateVersion: 7,
    redaction: "known-credentials",
    importSupported: false,
    excluded: [
      "credentials",
      "harness-auth",
      "repository-files",
      "browser-state",
      "unreferenced-files",
    ],
    entries,
  };
}

function report(
  entries: WorkspaceExportEntry[],
  overrides: Partial<WorkspaceArchiveInspectionReport> = {},
): WorkspaceArchiveInspectionReport {
  const payloadBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  return {
    manifest: manifest(entries),
    archiveBytes: payloadBytes + 2048,
    payloadBytes,
    ...overrides,
  };
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

function renderDialog(overrides: Partial<WorkspaceArchiveInspectionDialogProps> = {}) {
  const onClose = vi.fn();
  const utils = render(<WorkspaceArchiveInspectionDialog onClose={onClose} {...overrides} />);
  return { ...utils, onClose };
}

function pickZip(name = "alpha-export.zip", bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/zip" });
}

async function chooseAndCheck(user: ReturnType<typeof userEvent.setup>, name?: string) {
  await user.upload(screen.getByLabelText("Choose ZIP"), pickZip(name));
  await user.click(screen.getByRole("button", { name: "Check ZIP" }));
}

afterEach(() => {
  inspectMock.mockReset();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WorkspaceArchiveInspectionDialog", () => {
  it("keeps opening and selecting a ZIP inert until Check ZIP is clicked", async () => {
    inspectMock.mockResolvedValue(report([entry("ok.txt")]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    renderDialog();

    await user.upload(screen.getByLabelText("Choose ZIP"), pickZip());
    expect(screen.getByText("alpha-export.zip")).toBeInTheDocument();
    expect(screen.getByText(/1,024 bytes/)).toBeInTheDocument();
    expect(inspectMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check ZIP" }));
    expect(inspectMock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("checks the chosen File in the worker with a signal and progress callback", async () => {
    const pending = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    renderDialog();
    const file = pickZip("snapshot.zip");

    await user.upload(screen.getByLabelText("Choose ZIP"), file);
    await user.click(screen.getByRole("button", { name: "Check ZIP" }));

    expect(inspectMock).toHaveBeenCalledTimes(1);
    const [calledFile, options] = inspectMock.mock.calls[0] ?? [];
    expect(calledFile).toBe(file);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    expect(typeof options?.onProgress).toBe("function");
  });

  it("shows real progress and paginates a large verified entry list", async () => {
    const pending = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementation(async (_file, options) => {
      options?.onProgress?.({
        phase: "reading",
        verifiedEntries: 0,
        totalEntries: 0,
        verifiedBytes: 0,
        totalBytes: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      options?.onProgress?.({
        phase: "verifying",
        verifiedEntries: 12,
        totalEntries: 120,
        verifiedBytes: 1_000_000,
        totalBytes: 2_000_000,
      });
      return pending.promise;
    });
    const user = userEvent.setup();
    renderDialog();

    await chooseAndCheck(user);
    expect(await screen.findByText("Reading archive…")).toBeInTheDocument();
    expect(await screen.findByText(/Verifying 12 of 120 files/)).toBeInTheDocument();

    const manyEntries = Array.from({ length: 120 }, (_, index) => entry(`files/${index}.json`));
    await act(async () => {
      pending.resolve(report(manyEntries, { archiveBytes: 3_000_000, payloadBytes: 2_400_000 }));
    });

    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
    expect(screen.getByText("Archived Alpha")).toBeInTheDocument();
    expect(screen.getByText(/120 payload files verified, plus manifest/)).toBeInTheDocument();
    expect(screen.getByText("2.9 MiB")).toBeInTheDocument();
    expect(screen.getByText("2.3 MiB")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE + 1);
    expect(screen.queryByText("files/120.json")).not.toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Archive entries pages" });
    expect(within(nav).getByText("Page 1 of 3")).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Next" }));
    expect(within(nav).getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE + 1);
    expect(within(nav).getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("cancels the active check and allows a fresh attempt", async () => {
    const first = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => first.promise);
    const user = userEvent.setup();
    renderDialog();
    await chooseAndCheck(user);

    const firstOptions = inspectMock.mock.calls[0]?.[1];
    expect(firstOptions?.signal?.aborted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel check" }));
    expect(firstOptions?.signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Check ZIP" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const second = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => second.promise);
    await user.click(screen.getByRole("button", { name: "Check ZIP" }));
    expect(inspectMock).toHaveBeenCalledTimes(2);
    expect(inspectMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);

    await act(async () => {
      second.resolve(report([entry("ok.txt")]));
    });
    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
  });

  it("discards a stale result after selecting another ZIP while busy", async () => {
    const first = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => first.promise);
    const user = userEvent.setup();
    renderDialog();
    await chooseAndCheck(user, "alpha.zip");

    const firstSignal = inspectMock.mock.calls[0]?.[1]?.signal;
    await user.upload(screen.getByLabelText("Choose ZIP"), pickZip("beta.zip", 2048));
    expect(screen.getByText("beta.zip")).toBeInTheDocument();
    expect(screen.getByText(/2,048 bytes/)).toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      first.resolve(report([entry("stale.txt")]));
    });
    expect(screen.queryByText("Integrity verified")).not.toBeInTheDocument();
    expect(inspectMock).toHaveBeenCalledTimes(1);

    const second = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => second.promise);
    await user.click(screen.getByRole("button", { name: "Check ZIP" }));
    expect(inspectMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(report([entry("beta.txt")]));
    });
    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
  });

  it("rejects empty and oversized ZIPs without calling the worker", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.upload(screen.getByLabelText("Choose ZIP"), pickZip("empty.zip", 0));
    expect(screen.getByRole("alert")).toHaveTextContent("The selected file is empty.");
    expect(inspectMock).not.toHaveBeenCalled();

    const sizeSpy = vi
      .spyOn(Blob.prototype, "size", "get")
      .mockReturnValue(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1);
    await user.upload(screen.getByLabelText("Choose ZIP"), pickZip("big.zip", 10));
    expect(screen.getByRole("alert")).toHaveTextContent("larger than 136 MiB");
    expect(inspectMock).not.toHaveBeenCalled();
    sizeSpy.mockRestore();
  });

  it("shows a safe error with optional path and Try again starts a fresh check", async () => {
    inspectMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("ZIP structure is invalid."), {
        code: "invalid",
        path: "conversations/thread-1.jsonl",
      });
    });
    const user = userEvent.setup();
    renderDialog();
    await chooseAndCheck(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ZIP structure is invalid.");
    expect(alert).toHaveTextContent("conversations/thread-1.jsonl");
    expect(within(alert).queryByRole("link")).not.toBeInTheDocument();

    const retry = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => retry.promise);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(inspectMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve(report([entry("retried.txt")]));
    });
    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
  });

  it("aborts on unmount and ignores the late rejection", async () => {
    const pending = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    const { unmount } = renderDialog();
    await chooseAndCheck(user);

    const signal = inspectMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      pending.reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
    });
    expect(inspectMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes via the close button and Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not start under StrictMode until the user clicks Check ZIP", async () => {
    const pending = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <WorkspaceArchiveInspectionDialog onClose={vi.fn()} />
      </StrictMode>,
    );

    expect(inspectMock).not.toHaveBeenCalled();
    await user.upload(screen.getByLabelText("Choose ZIP"), pickZip());
    await user.click(screen.getByRole("button", { name: "Check ZIP" }));
    expect(inspectMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(report([entry("strict.txt")]));
    });
    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
  });

  it("keeps focus inside while the primary action changes state and restores the trigger", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "outside trigger";
    document.body.append(trigger);
    trigger.focus();
    const user = userEvent.setup();
    const { onClose, unmount } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Inspect workspace ZIP" });

    expect(screen.getByRole("button", { name: "Choose ZIP" })).toHaveFocus();
    const pending = deferred<WorkspaceArchiveInspectionReport>();
    inspectMock.mockImplementationOnce(() => pending.promise);
    await chooseAndCheck(user);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();

    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await act(async () => {
      pending.resolve(report([entry("focus.txt")]));
    });
    expect(await screen.findByText("Integrity verified")).toBeInTheDocument();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(trigger).toHaveFocus();
  });
});
