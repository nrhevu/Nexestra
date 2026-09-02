import type { MasterQuestion } from "@nexestra/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard.js";

const QUESTIONS: MasterQuestion[] = [
  {
    id: "q_outcome",
    text: "What does done look like?",
    options: ["A working CLI", "A polished feature"],
    allowFreeText: true,
  },
  { id: "q_scope", text: "What must stay untouched?", options: [], allowFreeText: true },
];

function setup(onSubmit = vi.fn()) {
  render(<QuestionCard callId="call_1" questions={QUESTIONS} onSubmit={onSubmit} />);
  return onSubmit;
}

describe("QuestionCard", () => {
  it("renders every question with its suggested options", () => {
    setup();
    expect(screen.getByText("What does done look like?")).toBeDefined();
    expect(screen.getByText("What must stay untouched?")).toBeDefined();
    expect(screen.getByRole("button", { name: /A working CLI/ })).toBeDefined();
    expect(screen.getByText("2 questions")).toBeDefined();
  });

  it("cannot be submitted until something is answered", () => {
    const onSubmit = setup();
    const submit = screen.getByRole("button", { name: /Submit answers/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("fills the field from an option, and keeps it editable", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /A working CLI/ }));

    const field = screen.getByLabelText(/What does done look like/) as HTMLInputElement;
    expect(field.value).toBe("A working CLI");

    fireEvent.change(field, { target: { value: "A working CLI, plus --json" } });
    expect(field.value).toBe("A working CLI, plus --json");
  });

  it("submits only the questions that were answered", () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole("button", { name: /A polished feature/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));

    expect(onSubmit).toHaveBeenCalledWith([{ id: "q_outcome", answer: "A polished feature" }]);
  });

  it("submits every answer when both are filled", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText(/What does done look like/), {
      target: { value: "a CLI" },
    });
    fireEvent.change(screen.getByLabelText(/What must stay untouched/), {
      target: { value: "the public API" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit answers/ }));

    expect(onSubmit).toHaveBeenCalledWith([
      { id: "q_outcome", answer: "a CLI" },
      { id: "q_scope", answer: "the public API" },
    ]);
  });

  it("does nothing while the answers are in flight", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard callId="call_1" questions={QUESTIONS} busy onSubmit={onSubmit} />);

    const submit = screen.getByRole("button", { name: /Sending/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
