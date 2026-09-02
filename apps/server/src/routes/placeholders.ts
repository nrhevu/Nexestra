import {
  mockFileContents,
  mockFileTree,
  mockHarnesses,
  mockTerminalLines,
} from "@nexestra/core/mock";
import { Hono } from "hono";

/**
 * Surfaces that still have no real backend in M1.
 *
 * - the Editor file tree, file contents and terminal output become a real
 *   worktree once the Codex adapter lands (M4);
 * - harness detection shells out to `codex` / `opencode` in M4/M5.
 *
 * They are served from the core fixtures so the Editor and Settings surfaces
 * keep rendering, and they are grouped here so it is obvious what is not real.
 */
export const placeholderRoutes = new Hono()
  .get("/files", (c) => c.json(mockFileTree))
  .get("/files/content", (c) => {
    const path = c.req.query("path");
    const file = mockFileContents.find((item) => item.path === path) ?? mockFileContents[0];
    return file ? c.json(file) : c.json({ error: "not_found" }, 404);
  })
  .get("/terminal", (c) => c.json({ lines: mockTerminalLines }))
  .get("/harnesses", (c) => c.json(mockHarnesses));
