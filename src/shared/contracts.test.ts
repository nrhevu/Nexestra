import { describe, expect, it } from "vitest";
import { extractMentionHandles, handleFromName } from "./contracts.js";

describe("extractMentionHandles", () => {
  it("deduplicates handles case-insensitively and ignores email addresses", () => {
    expect(extractMentionHandles("@Maya xem nhé, @codex và @maya. a@company.com")).toEqual([
      "maya",
      "codex",
    ]);
  });

  it("does not treat a one-character handle as valid", () => {
    expect(extractMentionHandles("hello @x and @xy")).toEqual(["xy"]);
  });
});

describe("handleFromName", () => {
  it("creates a stable ASCII handle from Vietnamese text", () => {
    expect(handleFromName("Điều phối Chính")).toBe("dieu-phoi-chinh");
  });
});
