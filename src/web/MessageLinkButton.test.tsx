// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageLinkButton } from "./MessageLinkButton.js";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const origin = window.location.origin;

function stubClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("MessageLinkButton", () => {
  it("copies a stable absolute message URL only after the clipboard write resolves", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    window.history.replaceState({}, "", "/threads/current?tab=notes#intro");
    render(<MessageLinkButton threadId="thread release" messageId="message/1?x=2" />);

    const button = screen.getByRole("button", { name: "Copy message link" });
    await user.click(button);

    expect(writeText).toHaveBeenCalledWith(
      `${origin}/threads/thread%20release?message=message%2F1%3Fx%3D2`,
    );
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it("shows the URL for manual copying when the Clipboard API is unavailable", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<MessageLinkButton threadId="thread-a" messageId="message-1" />);

    await user.click(screen.getByRole("button", { name: "Copy message link" }));

    const input = await screen.findByRole("textbox", { name: "Message link" });
    expect(input).toHaveValue(`${origin}/threads/thread-a?message=message-1`);
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("shows the URL for manual copying when the clipboard write is rejected", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    render(<MessageLinkButton threadId="thread-b" messageId="message-2" />);

    await user.click(screen.getByRole("button", { name: "Copy message link" }));

    const input = await screen.findByRole("textbox", { name: "Message link" });
    expect(input).toHaveValue(`${origin}/threads/thread-b?message=message-2`);
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("keeps focus elsewhere when a delayed clipboard rejection opens the manual fallback", async () => {
    const user = userEvent.setup();
    let rejectWrite: (reason?: unknown) => void = () => undefined;
    const deferred = new Promise<void>((_, rejectPromise) => {
      rejectWrite = rejectPromise;
    });
    stubClipboard(vi.fn().mockReturnValue(deferred));
    render(
      <>
        <MessageLinkButton threadId="thread-d" messageId="message-4" />
        <button type="button">Elsewhere</button>
      </>,
    );

    const button = screen.getByRole("button", { name: "Copy message link" });
    await user.click(button);
    expect(button).toBeDisabled();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    await user.click(elsewhere);
    await act(async () => {
      rejectWrite(new Error("denied"));
    });

    const input = await screen.findByRole("textbox", { name: "Message link" });
    expect(input).toHaveValue(`${origin}/threads/thread-d?message=message-4`);
    expect(elsewhere).toHaveFocus();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("can be activated from the keyboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<MessageLinkButton threadId="thread-c" messageId="message-3" />);

    screen.getByRole("button", { name: "Copy message link" }).focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${origin}/threads/thread-c?message=message-3`),
    );
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });
});
