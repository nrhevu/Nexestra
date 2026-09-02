import type { ThreadPhase } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PHASE_CONTEXT,
  isToolAllowedInPhase,
  MASTER_TOOL_NAMES,
  MASTER_TOOLS_BY_PHASE,
  nextPhase,
  type PhaseContext,
} from "./phase.js";

const READY_SPEC: PhaseContext = {
  ...EMPTY_PHASE_CONTEXT,
  acceptanceCriterionCount: 3,
};

describe("MASTER_TOOLS_BY_PHASE", () => {
  it("only names tools that exist", () => {
    for (const [phase, tools] of Object.entries(MASTER_TOOLS_BY_PHASE)) {
      for (const tool of tools) {
        expect(MASTER_TOOL_NAMES, `${phase}.${tool}`).toContain(tool);
      }
    }
  });

  it("exposes web_search only during intake and clarifying", () => {
    const withWebSearch = Object.entries(MASTER_TOOLS_BY_PHASE)
      .filter(([, tools]) => (tools as readonly string[]).includes("web_search"))
      .map(([phase]) => phase);
    expect(withWebSearch.sort()).toEqual(["clarifying", "intake"]);
  });

  it("gives a cancelled thread no tools at all", () => {
    expect(MASTER_TOOLS_BY_PHASE.cancelled).toHaveLength(0);
  });

  it("never exposes propose_plan before planning", () => {
    for (const phase of ["intake", "clarifying", "spec_frozen"] as const) {
      expect(isToolAllowedInPhase(phase, "propose_plan")).toBe(false);
    }
    expect(isToolAllowedInPhase("planning", "propose_plan")).toBe(true);
  });
});

describe("nextPhase", () => {
  it("moves intake → clarifying when the Master starts drafting", () => {
    const result = nextPhase("intake", { type: "clarification_started" });
    expect(result).toMatchObject({ ok: true, to: "clarifying", changed: true });
  });

  it("refuses to freeze a spec with open questions", () => {
    const result = nextPhase(
      "clarifying",
      { type: "spec_approved" },
      {
        ...READY_SPEC,
        openQuestionCount: 2,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/2 open question/);
  });

  it("refuses to freeze a spec with no acceptance criteria", () => {
    const result = nextPhase("clarifying", { type: "spec_approved" }, EMPTY_PHASE_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no acceptance criteria/);
  });

  it("freezes a complete spec", () => {
    const result = nextPhase("clarifying", { type: "spec_approved" }, READY_SPEC);
    expect(result).toMatchObject({ ok: true, to: "spec_frozen" });
  });

  it("only starts planning from spec_frozen", () => {
    expect(nextPhase("spec_frozen", { type: "planning_started" })).toMatchObject({
      ok: true,
      to: "planning",
    });
    expect(nextPhase("clarifying", { type: "planning_started" }).ok).toBe(false);
  });

  it("needs a validated plan before executing", () => {
    expect(nextPhase("planning", { type: "plan_accepted" }, READY_SPEC).ok).toBe(false);
    expect(
      nextPhase("planning", { type: "plan_accepted" }, { ...READY_SPEC, planProposed: true }),
    ).toMatchObject({ ok: true, to: "executing" });
  });

  it("only reaches done when every criterion has evidence", () => {
    const missing = nextPhase(
      "verifying",
      { type: "all_criteria_verified" },
      {
        ...READY_SPEC,
        unverifiedCriterionCount: 1,
      },
    );
    expect(missing.ok).toBe(false);
    expect(nextPhase("verifying", { type: "all_criteria_verified" }, READY_SPEC)).toMatchObject({
      ok: true,
      to: "done",
    });
  });

  it("sends a failed verification back to executing", () => {
    expect(nextPhase("verifying", { type: "verification_failed" })).toMatchObject({
      ok: true,
      to: "executing",
    });
  });

  it("accepts cancellation from every phase", () => {
    const phases: ThreadPhase[] = [
      "intake",
      "clarifying",
      "spec_frozen",
      "planning",
      "executing",
      "verifying",
      "done",
      "blocked",
      "cancelled",
    ];
    for (const phase of phases) {
      expect(nextPhase(phase, { type: "cancelled" }), phase).toMatchObject({
        ok: true,
        to: "cancelled",
      });
    }
  });

  it("rejects everything else once the thread is done", () => {
    expect(nextPhase("done", { type: "clarification_started" }).ok).toBe(false);
    expect(nextPhase("cancelled", { type: "plan_accepted" }).ok).toBe(false);
  });

  it("blocks and resumes", () => {
    expect(nextPhase("executing", { type: "blocked", reason: "budget" })).toMatchObject({
      ok: true,
      to: "blocked",
      reason: "budget",
    });
    expect(nextPhase("blocked", { type: "unblocked", resumePhase: "executing" })).toMatchObject({
      ok: true,
      to: "executing",
    });
    expect(nextPhase("blocked", { type: "unblocked", resumePhase: "done" }).ok).toBe(false);
    expect(nextPhase("executing", { type: "unblocked", resumePhase: "planning" }).ok).toBe(false);
  });

  it("is pure — the same call twice gives the same answer", () => {
    const first = nextPhase("clarifying", { type: "spec_approved" }, READY_SPEC);
    const second = nextPhase("clarifying", { type: "spec_approved" }, READY_SPEC);
    expect(first).toEqual(second);
  });
});
