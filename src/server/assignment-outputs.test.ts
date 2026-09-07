import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAssignmentOutputs } from "./assignment-outputs.js";
import { MAX_UPLOAD_BYTES } from "./store.js";

describe("Assignment output capture boundaries", () => {
  let root: string;
  const keep = (value: string) => value;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nexestra-output-"));
    await mkdir(join(root, "outputs"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("refuses symbolic and hard links instead of copying files from outside outputs", async () => {
    await writeFile(join(root, "private.txt"), "Do not capture");
    await symlink(join(root, "private.txt"), join(root, "outputs", "linked.txt"));
    await expect(collectAssignmentOutputs(root, keep)).rejects.toThrow(
      "Output links cannot be captured",
    );
    await rm(join(root, "outputs", "linked.txt"));
    await link(join(root, "private.txt"), join(root, "outputs", "linked.txt"));
    await expect(collectAssignmentOutputs(root, keep)).rejects.toThrow("not hard links");
  });
  it("bounds output count and bytes before reading deliverables into memory", async () => {
    await writeFile(join(root, "outputs", "large.bin"), "");
    await truncate(join(root, "outputs", "large.bin"), MAX_UPLOAD_BYTES + 1);
    await expect(collectAssignmentOutputs(root, keep)).rejects.toThrow("size limit");
    await rm(join(root, "outputs", "large.bin"));
    for (let i = 0; i < 11; i++) await writeFile(join(root, "outputs", `${i}.md`), "Small");
    await expect(collectAssignmentOutputs(root, keep)).rejects.toThrow("at most 10");
  });
  it("rejects known credentials in an output and permits ordinary document bytes", async () => {
    const file = join(root, "outputs", "memo.md");
    await writeFile(file, "A forbidden-marker in the memo");
    await expect(
      collectAssignmentOutputs(root, (value) => value.replaceAll("forbidden-marker", "[REDACTED]")),
    ).rejects.toThrow("stored credential");
    await writeFile(file, "A harmless memo");
    const outputs = await collectAssignmentOutputs(root, keep);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.bytes.toString()).toBe("A harmless memo");
  });
});
