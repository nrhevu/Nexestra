import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseGitNumstat } from "./git-numstat.js";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/git-numstat.json", import.meta.url), "utf8"),
) as { name: string; raw: string; expected: ReturnType<typeof parseGitNumstat> }[];

describe("Git numstat protocol", () => {
  it.each(fixtures)("parses $name", ({ raw, expected }) => {
    expect(parseGitNumstat(raw)).toEqual(expected);
  });

  it("caps listed files while preserving totals and marking the view incomplete", () => {
    expect(parseGitNumstat("1\t2\ta\0-\t-\tb\0" + "3\t4\tc\0", 2)).toEqual({
      files: [
        { path: "a", insertions: 1, deletions: 2 },
        { path: "b", insertions: null, deletions: null },
      ],
      insertions: 4,
      deletions: 6,
      truncated: true,
    });
  });

  it("rejects unsafe counts and does not treat a partial final record as complete", () => {
    expect(parseGitNumstat("9007199254740992\t0\thuge\0" + "1\t2\tpartial")).toEqual({
      files: [],
      insertions: 0,
      deletions: 0,
      truncated: true,
    });
  });
});
