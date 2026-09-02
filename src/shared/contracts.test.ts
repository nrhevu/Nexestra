import { describe, expect, it } from "vitest";
import { extractMentionHandles, handleFromName } from "./contracts.js";

describe("extractMentionHandles", () => {
  it("deduplicates handles case-insensitively and ignores email addresses", () => {
    expect(extractMentionHandles("@Maya take a look, @codex and @maya. a@company.com")).toEqual([
      "maya",
      "codex",
    ]);
  });

  it("does not treat a one-character handle as valid", () => {
    expect(extractMentionHandles("hello @x and @xy")).toEqual(["xy"]);
  });
});

describe("handleFromName", () => {
  it("normalizes a stroked D to an ASCII handle", () => {
    expect(handleFromName("\u0110elta Coordinator")).toBe("delta-coordinator");
  });
});
