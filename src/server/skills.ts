import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { MasterToolContext } from "./harness-tool-types.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_BYTES = 256 * 1024;

export interface HarnessSkill {
  name: string;
  description: string;
  path: string;
}

export async function discoverSkills(context: MasterToolContext): Promise<HarnessSkill[]> {
  const env = context.env ?? process.env;
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const roots = [
    join(context.workspacePath, ".opencode", "skills"),
    join(context.workspacePath, ".claude", "skills"),
    join(context.workspacePath, ".agents", "skills"),
    join(xdg, "opencode", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
  ];
  const allowedRoots = await Promise.all(
    [context.workspacePath, home].map((path) => realpath(path).catch(() => resolve(path))),
  );
  const skills = new Map<string, HarnessSkill>();
  for (const root of roots) {
    for (const file of await skillFiles(root, allowedRoots)) {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > MAX_SKILL_BYTES) continue;
        const source = await readFile(file, "utf8");
        const metadata = parseFrontmatter(source);
        if (!metadata || !SKILL_NAME.test(metadata.name) || skills.has(metadata.name)) continue;
        skills.set(metadata.name, { ...metadata, path: file });
      } catch {
        // An unreadable skill is omitted without breaking the whole harness.
      }
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function readSkill(skill: HarnessSkill): Promise<string> {
  const info = await lstat(skill.path);
  if (!info.isFile() || info.size > MAX_SKILL_BYTES) throw new Error("Skill is too large to load.");
  return readFile(skill.path, "utf8");
}

export function skillDescription(skills: HarnessSkill[]): string {
  if (skills.length === 0) {
    return "Load a repository or user skill by name. No skills are currently installed.";
  }
  const catalog = skills
    .slice(0, 50)
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join("; ");
  return `Load detailed instructions from an installed skill by name. Available skills: ${catalog}`.slice(
    0,
    4_000,
  );
}

async function skillFiles(root: string, allowedRoots: string[]): Promise<string[]> {
  try {
    const resolved = await realpath(root);
    if (
      !allowedRoots.some(
        (allowed) => resolved === allowed || resolved.startsWith(`${allowed}${sep}`),
      )
    ) {
      return [];
    }
    const entries = await readdir(resolved, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name))
      .slice(0, 200)
      .map((entry) => join(resolved, entry.name, "SKILL.md"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

function parseFrontmatter(source: string): { name: string; description: string } | undefined {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const values = new Map<string, string>();
  for (const line of source.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    values.set(match[1], unquote(match[2].trim()));
  }
  const name = values.get("name");
  const description = values.get("description");
  if (!name || !description || description.length > 1_000) return undefined;
  return { name, description };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
