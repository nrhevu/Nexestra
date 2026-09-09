// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceArchiveDialogComponent,
  WorkspaceArchiveDialogProps,
} from "./workspace-archive-dialog-contracts.js";

const loaderMock = vi.hoisted(() => {
  class WorkspaceArchiveDialogLoadError extends Error {
    readonly reason: "load" | "timeout";

    constructor(reason: "load" | "timeout") {
      super(
        reason === "timeout"
          ? "The archive dialog took too long to load."
          : "The archive dialog could not be loaded.",
      );
      this.name = "WorkspaceArchiveDialogLoadError";
      this.reason = reason;
    }
  }
  return {
    loadWorkspaceArchiveDialog: vi.fn(),
    WorkspaceArchiveDialogLoadError,
  };
});

vi.mock("./workspace-archive-dialog-loader.js", () => loaderMock);

import { WorkspaceArchiveDialog } from "./WorkspaceArchiveDialog.js";

const ExportDialog: WorkspaceArchiveDialogComponent = ({ workspace, onClose }) => (
  <div>
    <span>
      export-ready:{workspace.id}:{workspace.name}
    </span>
    <button type="button" onClick={onClose}>
      close export
    </button>
  </div>
);

const InspectionDialog: WorkspaceArchiveDialogComponent = ({ workspace, onClose }) => (
  <div>
    <span>
      inspection-ready:{workspace.id}:{workspace.name}
    </span>
    <button type="button" onClick={onClose}>
      close inspection
    </button>
  </div>
);

function FocusHandlingDialog({ onClose }: { onClose: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousActiveRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    buttonRef.current?.focus();
    return () => {
      previousActiveRef.current?.focus();
    };
  }, []);
  return (
    <div>
      <button ref={buttonRef} type="button" onClick={onClose}>
        focused close
      </button>
    </div>
  );
}

function deferredComponent() {
  let resolve!: (component: WorkspaceArchiveDialogComponent) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WorkspaceArchiveDialogComponent>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseProps: WorkspaceArchiveDialogProps = {
  kind: "export",
  workspace: { id: "workspace-a", name: "Alpha" },
  onClose: vi.fn(),
};

beforeEach(() => {
  loaderMock.loadWorkspaceArchiveDialog.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkspaceArchiveDialog", () => {
  it("shows the loading shell and hands off with current workspace and close props", async () => {
    const { promise, resolve } = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(promise);
    const firstClose = vi.fn();

    const view = render(
      <WorkspaceArchiveDialog
        kind="export"
        workspace={{ id: "workspace-a", name: "Alpha" }}
        onClose={firstClose}
      />,
    );
    expect(screen.getByRole("dialog", { name: /export workspace/i })).toBeInTheDocument();
    expect(screen.getByText(/loading export dialog/i)).toBeInTheDocument();
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledWith("export");

    const secondClose = vi.fn();
    view.rerender(
      <WorkspaceArchiveDialog
        kind="export"
        workspace={{ id: "workspace-a", name: "Alpha renamed" }}
        onClose={secondClose}
      />,
    );
    await act(async () => {
      resolve(ExportDialog);
      await promise;
    });
    expect(screen.getByText("export-ready:workspace-a:Alpha renamed")).toBeInTheDocument();

    const thirdClose = vi.fn();
    view.rerender(
      <WorkspaceArchiveDialog
        kind="export"
        workspace={{ id: "workspace-a", name: "Alpha latest" }}
        onClose={thirdClose}
      />,
    );
    expect(screen.getByText("export-ready:workspace-a:Alpha latest")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "close export" }));
    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).not.toHaveBeenCalled();
    expect(thirdClose).toHaveBeenCalledTimes(1);
  });

  it("shows a load failure and retries with a new attempt", async () => {
    const onClose = vi.fn();
    loaderMock.loadWorkspaceArchiveDialog
      .mockRejectedValueOnce(new loaderMock.WorkspaceArchiveDialogLoadError("load"))
      .mockResolvedValueOnce(ExportDialog);

    render(<WorkspaceArchiveDialog {...baseProps} onClose={onClose} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The dialog could not be loaded.");

    await userEvent.click(screen.getByRole("button", { name: /retry loading/i }));
    await screen.findByText("export-ready:workspace-a:Alpha");
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledTimes(2);
  });

  it("shows a timeout failure and still allows close", async () => {
    const onClose = vi.fn();
    loaderMock.loadWorkspaceArchiveDialog.mockRejectedValue(
      new loaderMock.WorkspaceArchiveDialogLoadError("timeout"),
    );

    render(<WorkspaceArchiveDialog {...baseProps} onClose={onClose} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The dialog timed out while loading.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not mount a late dialog after closing", async () => {
    const { promise, resolve } = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(promise);
    vi.stubGlobal("fetch", vi.fn());

    const { unmount } = render(<WorkspaceArchiveDialog {...baseProps} />);
    unmount();
    await act(async () => {
      resolve(ExportDialog);
      await promise;
    });
    expect(screen.queryByText(/export-ready:/i)).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ignores a pending load when the workspace changes", async () => {
    const first = deferredComponent();
    const second = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const view = render(
      <WorkspaceArchiveDialog
        kind="export"
        workspace={{ id: "workspace-a", name: "Alpha" }}
        onClose={vi.fn()}
      />,
    );
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledTimes(1);

    view.rerender(
      <WorkspaceArchiveDialog
        kind="export"
        workspace={{ id: "workspace-b", name: "Beta" }}
        onClose={vi.fn()}
      />,
    );
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(ExportDialog);
      await first.promise;
    });
    expect(screen.queryByText(/export-ready:/i)).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(ExportDialog);
      await second.promise;
    });
    expect(screen.getByText("export-ready:workspace-b:Beta")).toBeInTheDocument();
  });

  it("ignores a pending load when the kind changes", async () => {
    const exportLoad = deferredComponent();
    const inspectionLoad = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog
      .mockReturnValueOnce(exportLoad.promise)
      .mockReturnValueOnce(inspectionLoad.promise);

    const view = render(<WorkspaceArchiveDialog {...baseProps} />);
    view.rerender(<WorkspaceArchiveDialog {...baseProps} kind="inspection" />);

    await act(async () => {
      exportLoad.resolve(ExportDialog);
      await exportLoad.promise;
    });
    expect(screen.queryByText(/export-ready:/i)).not.toBeInTheDocument();

    await act(async () => {
      inspectionLoad.resolve(InspectionDialog);
      await inspectionLoad.promise;
    });
    expect(screen.getByText("inspection-ready:workspace-a:Alpha")).toBeInTheDocument();
  });

  it("coalesces repeated StrictMode effects through the loader", async () => {
    const shared = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(shared.promise);

    render(
      <StrictMode>
        <WorkspaceArchiveDialog {...baseProps} />
      </StrictMode>,
    );
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledTimes(2);
    expect(loaderMock.loadWorkspaceArchiveDialog.mock.results[0]?.value).toBe(
      loaderMock.loadWorkspaceArchiveDialog.mock.results[1]?.value,
    );

    await act(async () => {
      shared.resolve(ExportDialog);
      await shared.promise;
    });
    expect(screen.getByText("export-ready:workspace-a:Alpha")).toBeInTheDocument();
    expect(loaderMock.loadWorkspaceArchiveDialog).toHaveBeenCalledTimes(2);
  });

  it("restores pre-open focus after the loading shell is removed", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { promise } = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(promise);

    const { unmount } = render(<WorkspaceArchiveDialog {...baseProps} />);
    expect(trigger).not.toHaveFocus();
    unmount();
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    trigger.remove();
  });

  it("does not let a loaded dialog steal final focus from the pre-open control", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { promise, resolve } = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(promise);

    const { unmount } = render(<WorkspaceArchiveDialog {...baseProps} />);
    await act(async () => {
      resolve(FocusHandlingDialog as unknown as WorkspaceArchiveDialogComponent);
      await promise;
    });
    expect(screen.getByRole("button", { name: "focused close" })).toHaveFocus();

    unmount();
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    trigger.remove();
  });

  it("does not steal focus from a connected outside control focused while open", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const rail = document.createElement("button");
    document.body.appendChild(rail);
    const { promise } = deferredComponent();
    loaderMock.loadWorkspaceArchiveDialog.mockReturnValue(promise);

    const { unmount } = render(<WorkspaceArchiveDialog {...baseProps} />);
    rail.focus();
    expect(rail).toHaveFocus();
    unmount();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(rail).toHaveFocus();
    expect(trigger).not.toHaveFocus();
    rail.remove();
    trigger.remove();
  });
});
