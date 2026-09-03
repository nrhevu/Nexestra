import { describe, expect, it } from "vitest";
import { extractKnowledgeHandles, extractMentionHandles, handleFromName } from "./contracts.js";

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

describe("extractKnowledgeHandles", () => {
  it("deduplicates references and ignores fenced and inline code", () => {
    expect(
      extractKnowledgeHandles(
        "Use #Product-Repo with #architecture and #product-repo. `#inline-code`\n```txt\n#fenced\n```",
      ),
    ).toEqual(["product-repo", "architecture"]);
  });

  it("does not parse URL fragments or one-character handles", () => {
    expect(extractKnowledgeHandles("https://example.com/page#section and #x but #xy")).toEqual([
      "xy",
    ]);
  });
});
