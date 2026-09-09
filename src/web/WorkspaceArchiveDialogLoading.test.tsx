// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

import { WorkspaceArchiveDialogLoading } from "./WorkspaceArchiveDialogLoading.js";
import type { WorkspaceArchiveDialogLoadingProps } from "./workspace-archive-dialog-contracts.js";

const BASE: WorkspaceArchiveDialogLoadingProps = {
  kind: "export",
  failure: null,
  onRetry: () => {},
  onClose: () => {},
};

function props(overrides: Partial<WorkspaceArchiveDialogLoadingProps>) {
  return { ...BASE, ...overrides };
}

describe("WorkspaceArchiveDialogLoading", () => {
  it("shows the export title, pending status, and only an enabled Close while pending", () => {
    render(<WorkspaceArchiveDialogLoading {...props({ kind: "export" })} />);
    expect(screen.getByRole("dialog", { name: "Export workspace" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading export dialog…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry loading/ })).not.toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();
    expect(close).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });
  it("shows the inspection title and pending status", () => {
    render(<WorkspaceArchiveDialogLoading {...props({ kind: "inspection" })} />);
    expect(screen.getByRole("dialog", { name: "Inspect workspace ZIP" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading ZIP inspector…");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes on the Close button click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WorkspaceArchiveDialogLoading {...props({ onClose })} />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls the latest onClose on Escape after the callback prop changes", async () => {
    const user = userEvent.setup();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const { rerender } = render(
      <WorkspaceArchiveDialogLoading {...props({ onClose: firstClose })} />,
    );
    rerender(<WorkspaceArchiveDialogLoading {...props({ onClose: secondClose })} />);
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    expect(dialog).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(firstClose).not.toHaveBeenCalled();
  });

  it("shows load failure copy and retries", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<WorkspaceArchiveDialogLoading {...props({ failure: "load", onRetry })} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The dialog could not be loaded.");
    expect(alert).toHaveTextContent("No export or inspection was started.");
    const retry = screen.getByRole("button", { name: /Retry loading/ });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("shows timeout failure copy and can retry again", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<WorkspaceArchiveDialogLoading {...props({ failure: "timeout", onRetry })} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The dialog timed out while loading.");
    await user.click(screen.getByRole("button", { name: /Retry loading/ }));
    await user.click(screen.getByRole("button", { name: /Retry loading/ }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
  it("traps Tab and Shift+Tab between enabled controls once Retry appears", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkspaceArchiveDialogLoading {...props({})} />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    rerender(<WorkspaceArchiveDialogLoading {...props({ failure: "load" })} />);
    const retry = screen.getByRole("button", { name: /Retry loading/ });
    expect(close).toHaveFocus();
    await user.tab();
    expect(retry).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(retry).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it("keeps Escape inactive after unmount and is StrictMode safe", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <WorkspaceArchiveDialogLoading {...props({ onClose })} />
      </StrictMode>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
