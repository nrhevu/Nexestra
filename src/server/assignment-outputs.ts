import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  StoreError,
  type UploadArtifactInput,
} from "./store.js";

/** Capture a bounded set of ordinary files, never symlinks or hard links to other workspace data. */
export async function collectAssignmentOutputs(
  workingDirectory: string,
  redact: (value: string) => string,
): Promise<UploadArtifactInput[]> {
  const root = await realpath(workingDirectory);
  const outputDirectory = join(root, "outputs");
  const outputs: UploadArtifactInput[] = [];
  let totalBytes = 0;
  let entriesSeen = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new StoreError(
        "invalid",
        "The outputs directory must be a real directory, not a link.",
      );
    if (depth > 5)
      throw new StoreError(
        "invalid",
        "Output directories are too deeply nested. Keep deliverables within five levels.",
      );
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++entriesSeen > 500)
        throw new StoreError(
          "invalid",
          "Too many output entries. Keep only the deliverables in outputs/.",
        );
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new StoreError(
          "invalid",
          "Output links cannot be captured. Copy the intended deliverable into outputs/.",
        );
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile())
        throw new StoreError("invalid", "Only regular deliverable files can be captured.");
      const canonical = await realpath(path);
      const local = relative(root, canonical);
      if (isAbsolute(local) || local.startsWith(".."))
        throw new StoreError("invalid", "An output escapes its assignment workspace.");
      if (outputs.length >= MAX_UPLOAD_FILES)
        throw new StoreError(
          "invalid",
          `Keep at most ${MAX_UPLOAD_FILES} deliverables in outputs/.`,
        );
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1)
          throw new StoreError(
            "invalid",
            "Output files must be independent regular files, not hard links.",
          );
        if (before.size > MAX_UPLOAD_BYTES || totalBytes + before.size > MAX_UPLOAD_TOTAL_BYTES)
          throw new StoreError(
            "invalid",
            "Outputs exceed the attachment size limit. Reduce the deliverables and try again.",
          );
        const bytes = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = await handle.read(bytes, count, bytes.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await handle.stat();
        if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
          throw new StoreError(
            "conflict",
            "An output changed while being captured. Finish writing the deliverable before submitting.",
          );
        const content = bytes.subarray(0, count);
        if (redact(content.toString("utf8")) !== content.toString("utf8"))
          throw new StoreError(
            "invalid",
            "An output contains a stored credential. Remove it before submitting the deliverable.",
          );
        outputs.push({
          name: redact(relative(outputDirectory, path).replaceAll("\\", "/")),
          bytes: content,
        });
        totalBytes += count;
      } finally {
        await handle.close();
      }
    }
  };
  await visit(outputDirectory, 0);
  return outputs;
}
