export interface GitNumstatFile {
  path: string;
  insertions: number | null;
  deletions: number | null;
}

// Parse `git diff --numstat --no-renames -z`. The first two tabs delimit the counts;
// every remaining byte before NUL belongs to the filename, including tabs and newlines.
export function parseGitNumstat(raw: string, maxFiles = 200) {
  const files: GitNumstatFile[] = [];
  let insertions = 0;
  let deletions = 0;
  let truncated = false;
  const records = raw.split("\0");
  if (records.pop() !== "") truncated = true;
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab <= firstTab + 1 || secondTab === record.length - 1) {
      truncated = true;
      continue;
    }
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const binary = added === "-" && removed === "-";
    const addedCount = binary ? null : parseCount(added);
    const removedCount = binary ? null : parseCount(removed);
    if (!binary && (addedCount === null || removedCount === null)) {
      truncated = true;
      continue;
    }
    const nextInsertions = insertions + (addedCount ?? 0);
    const nextDeletions = deletions + (removedCount ?? 0);
    if (!Number.isSafeInteger(nextInsertions) || !Number.isSafeInteger(nextDeletions)) {
      truncated = true;
      continue;
    }
    insertions = nextInsertions;
    deletions = nextDeletions;
    if (files.length < maxFiles) {
      files.push({
        path: record.slice(secondTab + 1),
        insertions: addedCount,
        deletions: removedCount,
      });
    } else truncated = true;
  }
  return { files, insertions, deletions, truncated };
}

function parseCount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}
