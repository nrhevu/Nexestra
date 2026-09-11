import {
  KNOWLEDGE_BRANCH_LIST_MAX_ROWS,
  KNOWLEDGE_BRANCH_NAME_MAX_LENGTH,
} from "../shared/contracts.js";

export interface GitLsRemoteBranch {
  name: string;
  commit: string;
}

export interface ParsedGitLsRemoteBranches {
  branches: GitLsRemoteBranch[];
  truncated: boolean;
}

export interface ParseGitLsRemoteBranchesOptions {
  maxRows?: number;
  maxNameLength?: number;
  redact?: (value: string) => string;
}

export function parseGitLsRemoteBranches(
  rawOutput: string,
  options: ParseGitLsRemoteBranchesOptions = {},
): ParsedGitLsRemoteBranches {
  const maxRows = options.maxRows ?? KNOWLEDGE_BRANCH_LIST_MAX_ROWS;
  const maxNameLength = options.maxNameLength ?? KNOWLEDGE_BRANCH_NAME_MAX_LENGTH;
  const redact = options.redact ?? ((value: string) => value);
  const branches: GitLsRemoteBranch[] = [];
  let skipped = false;
  for (let line of rawOutput.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      skipped = true;
      continue;
    }
    const commit = line.slice(0, tab);
    const ref = line.slice(tab + 1);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
      skipped = true;
      continue;
    }
    if (!ref.startsWith("refs/heads/")) continue;
    if (ref.endsWith("^{}")) continue;
    const name = ref.slice("refs/heads/".length);
    if (!isRepresentableBranchName(name, maxNameLength) || redact(name) !== name) {
      skipped = true;
      continue;
    }
    branches.push({ name, commit });
  }
  branches.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    branches: branches.slice(0, maxRows),
    truncated: skipped || branches.length > maxRows,
  };
}

export function isRepresentableBranchName(name: string, maxLength: number): boolean {
  if (!name || name.length > maxLength || name.startsWith("-")) return false;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      code === 0x7f ||
      code === 0xfffd ||
      [0x20, 0x2a, 0x3a, 0x3f, 0x5b, 0x5c, 0x5d, 0x5e, 0x7e].includes(code)
    ) {
      return false;
    }
  }
  if (name.includes("..") || name.includes("@{")) return false;
  const components = name.split("/");
  if (
    components.some(
      (part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
    )
  ) {
    return false;
  }
  return true;
}
