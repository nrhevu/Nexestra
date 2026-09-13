import type { WorkspaceExportEntry } from "./contracts.js";

export interface RestoreTargetEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface RestorePathCategories {
  safeToCreate: string[];
  existingIdentical: string[];
  conflicts: string[];
}

export function categorizeRestorePaths(
  archiveEntries: readonly Pick<WorkspaceExportEntry, "path" | "bytes" | "sha256">[],
  targetEntries: readonly RestoreTargetEntry[],
): RestorePathCategories {
  const targets = new Map(targetEntries.map((entry) => [entry.path, entry]));
  const safeToCreate: string[] = [];
  const existingIdentical: string[] = [];
  const conflicts: string[] = [];
  for (const entry of archiveEntries) {
    const target = targets.get(entry.path);
    if (!target) safeToCreate.push(entry.path);
    else if (target.bytes === entry.bytes && target.sha256 === entry.sha256)
      existingIdentical.push(entry.path);
    else conflicts.push(entry.path);
  }
  return {
    safeToCreate: safeToCreate.slice(0, 100),
    existingIdentical: existingIdentical.slice(0, 100),
    conflicts: conflicts.slice(0, 100),
  };
}
