import { describe, expect, it } from "vitest";
import {
  defaultScenarioFor,
  fakeCostUSD,
  fileContentFor,
  filesFromInstructions,
  isFakeScenario,
  scenarioFromInstructions,
} from "./scenarios.js";

describe("scenarioFromInstructions", () => {
  it("reads an explicit marker", () => {
    expect(scenarioFromInstructions("Do the thing.\n[scenario: slow]")).toBe("slow");
    expect(scenarioFromInstructions("nexestra-scenario=fatal_failure")).toBe("fatal_failure");
    expect(scenarioFromInstructions('scenario: "review_clean"')).toBe("review_clean");
  });

  it("reads a bare scenario name from prose", () => {
    expect(
      scenarioFromInstructions("Fail once first, please: retryable_failure_then_success."),
    ).toBe("retryable_failure_then_success");
  });

  it("prefers the longer name when two overlap", () => {
    expect(scenarioFromInstructions("review_with_findings")).toBe("review_with_findings");
  });

  it("returns undefined when nothing says", () => {
    expect(scenarioFromInstructions("Write a CLI that lists todos.")).toBeUndefined();
  });

  it("falls back on the run kind", () => {
    expect(defaultScenarioFor("execute")).toBe("success");
    expect(defaultScenarioFor("verify")).toBe("success");
    expect(defaultScenarioFor("review")).toBe("review_clean");
  });

  it("validates names", () => {
    expect(isFakeScenario("success")).toBe(true);
    expect(isFakeScenario("nonsense")).toBe(false);
  });
});

describe("filesFromInstructions", () => {
  it("prefers backticked paths", () => {
    const files = filesFromInstructions(
      "Create `src/hello.ts` and `src/hello.test.ts`. Do not touch other.ts.",
    );
    expect(files).toEqual(["src/hello.ts", "src/hello.test.ts"]);
  });

  it("falls back to bare paths", () => {
    expect(filesFromInstructions("Add a file called hello.ts to the repo")).toEqual(["hello.ts"]);
  });

  it("refuses absolute paths, traversal and project config", () => {
    expect(filesFromInstructions("Edit `/etc/passwd` and `../outside.ts`")).toEqual([]);
    expect(filesFromInstructions("Edit `package.json`")).toEqual([]);
  });

  it("finds nothing when nothing looks like a path", () => {
    expect(filesFromInstructions("Make the tests pass")).toEqual([]);
  });
});

describe("fileContentFor", () => {
  it("produces content that parses for the extension", () => {
    expect(fileContentFor("src/hello.ts", "task_a")).toContain("export const hello =");
    expect(JSON.parse(fileContentFor("data.json", "task_a"))).toMatchObject({ taskId: "task_a" });
    expect(fileContentFor("notes.md", "task_a").startsWith("# notes")).toBe(true);
    expect(fileContentFor("thing.txt", "task_a")).toContain("task_a");
  });

  it("is deterministic", () => {
    expect(fileContentFor("a.ts", "task_a")).toBe(fileContentFor("a.ts", "task_a"));
  });
});

describe("fakeCostUSD", () => {
  it("prices tokens like an Opus-class model", () => {
    expect(fakeCostUSD(1_000_000, 0)).toBe(3);
    expect(fakeCostUSD(0, 1_000_000)).toBe(15);
    expect(fakeCostUSD(1200, 300)).toBeGreaterThan(0);
  });
});
