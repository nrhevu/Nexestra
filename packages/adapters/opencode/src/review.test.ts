import { describe, expect, it } from "vitest";
import { buildReviewPrompt, describeReviewTarget, parseReviewFindings } from "./review.js";

describe("buildReviewPrompt", () => {
  it("states the scope and asks for a fenced JSON block", () => {
    const prompt = buildReviewPrompt("Check the error handling.", { mode: "base", ref: "main" });
    expect(prompt).toContain("Check the error handling.");
    expect(prompt).toContain("git diff main...HEAD");
    expect(prompt).toContain("```json");
    expect(prompt).toContain("read-only");
  });

  it("defaults to the uncommitted diff", () => {
    expect(describeReviewTarget(undefined)).toContain("uncommitted");
    expect(describeReviewTarget({ mode: "commit", sha: "abc123" })).toContain("git show abc123");
  });
});

describe("parseReviewFindings", () => {
  it("reads the fenced block out of a prose answer", () => {
    const message = [
      "I looked at the diff and found one problem.",
      "",
      "```json",
      '{"summary":"one bug","findings":[{"title":"Unchecked index","severity":"high",',
      '"file":"src/a.ts","line":12,"body":"Guard the array access."}]}',
      "```",
    ].join("\n");
    const review = parseReviewFindings(message);
    expect(review?.summary).toBe("one bug");
    expect(review?.findings).toEqual([
      {
        title: "Unchecked index",
        severity: "high",
        file: "src/a.ts",
        line: 12,
        body: "Guard the array access.",
      },
    ]);
  });

  it("prefers the last block, so an example above it does not win", () => {
    const message = [
      "Format:",
      "```json",
      '{"summary":"example","findings":[]}',
      "```",
      "Result:",
      "```json",
      '{"summary":"real","findings":[]}',
      "```",
    ].join("\n");
    expect(parseReviewFindings(message)?.summary).toBe("real");
  });

  it("prefers harness-provided structured output over the message", () => {
    const review = parseReviewFindings('```json\n{"summary":"text"}\n```', {
      summary: "structured",
      findings: [],
    });
    expect(review?.summary).toBe("structured");
  });

  it("accepts a bare array and a bare object", () => {
    expect(parseReviewFindings('[{"title":"a","body":"b"}]')?.findings).toHaveLength(1);
    expect(parseReviewFindings('{"findings":[]}')?.findings).toEqual([]);
  });

  it("normalises the severity vocabulary models actually use", () => {
    const review = parseReviewFindings(
      '[{"title":"a","body":"b","severity":"blocker"},{"title":"c","body":"d","severity":"warning"},' +
        '{"title":"e","body":"f","severity":"nit"},{"title":"g","body":"h"}]',
    );
    expect(review?.findings.map((finding) => finding.severity)).toEqual([
      "critical",
      "medium",
      "low",
      "info",
    ]);
  });

  it("fills in a title from the body and tolerates a string line number", () => {
    const review = parseReviewFindings('[{"message":"Race in the queue drain","line":"7"}]');
    expect(review?.findings[0]).toMatchObject({
      title: "Race in the queue drain",
      body: "Race in the queue drain",
      line: 7,
      file: null,
    });
  });

  it("returns undefined for prose, so the caller keeps final.message", () => {
    expect(parseReviewFindings("The change looks fine to me.")).toBeUndefined();
    expect(parseReviewFindings(undefined)).toBeUndefined();
    expect(parseReviewFindings("```json\nnot json\n```")).toBeUndefined();
  });
});
