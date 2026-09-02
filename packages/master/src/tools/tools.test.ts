import { describe, expect, it } from "vitest";
import { MASTER_TOOLS_BY_PHASE } from "../phase.js";
import { MASTER_TOOL_DEFINITIONS, toolJsonSchema, toolsForPhase } from "./definitions.js";
import { toStrictJsonSchema } from "./json-schema.js";
import {
  AskUserInputSchema,
  MarkCriterionInputSchema,
  ProposePlanInputSchema,
  UpdateSpecInputSchema,
} from "./schemas.js";

function everyObjectNode(node: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const entry of node) everyObjectNode(entry, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.type === "object") visit(record);
  for (const value of Object.values(record)) everyObjectNode(value, visit);
}

describe("tool JSON schemas", () => {
  it("are strict everywhere", () => {
    for (const tool of MASTER_TOOL_DEFINITIONS) {
      const schema = toolJsonSchema(tool);
      expect(schema.type, tool.name).toBe("object");
      everyObjectNode(schema, (object) => {
        expect(object.additionalProperties, tool.name).toBe(false);
      });
      expect(JSON.stringify(schema), tool.name).not.toContain("$schema");
    }
  });

  it("keep enum constraints instead of demoting them to prose", () => {
    const schema = toStrictJsonSchema(MarkCriterionInputSchema);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.passed?.type).toBe("boolean");
    const plan = toStrictJsonSchema(ProposePlanInputSchema);
    const asText = JSON.stringify(plan);
    expect(asText).toContain('"codex"');
    expect(asText).toContain("workspace-write");
  });

  it("mark exactly the mandatory fields as required", () => {
    const schema = toStrictJsonSchema(AskUserInputSchema);
    expect(schema.required).toEqual(["questions"]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const question = properties.questions?.items as Record<string, unknown>;
    expect(question.required).toEqual(["id", "text"]);
  });

  it("are stable across calls (the tool list has to stay cacheable)", () => {
    const first = JSON.stringify(toolsForPhase("clarifying"));
    const second = JSON.stringify(toolsForPhase("clarifying"));
    expect(first).toBe(second);
  });
});

describe("toolsForPhase", () => {
  it("matches the phase table and marks tools strict", () => {
    for (const [phase, expected] of Object.entries(MASTER_TOOLS_BY_PHASE)) {
      const tools = toolsForPhase(phase as keyof typeof MASTER_TOOLS_BY_PHASE);
      const names = tools.map((tool) => ("name" in tool ? tool.name : tool.type));
      expect(new Set(names), phase).toEqual(new Set(expected));
      for (const tool of tools) {
        if ("input_schema" in tool) expect((tool as { strict?: boolean }).strict).toBe(true);
      }
    }
  });

  it("puts the cache breakpoint on the last tool only", () => {
    const tools = toolsForPhase("clarifying", { cache: true });
    const withCache = tools.filter((tool) => "cache_control" in tool && tool.cache_control);
    expect(withCache).toHaveLength(1);
    expect(withCache[0]).toBe(tools[tools.length - 1]);
  });

  it("can drop tools the host cannot service", () => {
    const names = toolsForPhase("intake", { exclude: ["web_search", "search_code"] }).map((tool) =>
      "name" in tool ? tool.name : tool.type,
    );
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("search_code");
    expect(names).toContain("read_workspace");
  });
});

describe("tool input validation", () => {
  it("rejects an ask_user batch larger than the stop rule allows", () => {
    const questions = Array.from({ length: 7 }, (_, index) => ({
      id: `q${index}`,
      text: `question ${index}`,
    }));
    expect(AskUserInputSchema.safeParse({ questions }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ questions: questions.slice(0, 6) }).success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const parsed = UpdateSpecInputSchema.safeParse({ patch: { goal: "x" }, nope: 1 });
    // zod strips unknown keys by default; the JSON schema is what stops the model.
    expect(parsed.success).toBe(true);
    const schema = toStrictJsonSchema(UpdateSpecInputSchema);
    expect(schema.additionalProperties).toBe(false);
  });

  it("requires every acceptance criterion to carry a verification", () => {
    const bad = UpdateSpecInputSchema.safeParse({
      patch: { acceptanceCriteria: [{ id: "ac1", text: "works" }] },
    });
    expect(bad.success).toBe(false);
    const good = UpdateSpecInputSchema.safeParse({
      patch: {
        acceptanceCriteria: [
          { id: "ac1", text: "works", verification: { kind: "test", command: "pnpm test" } },
        ],
      },
    });
    expect(good.success).toBe(true);
  });

  it("requires each plan task to name a criterion and a harness config", () => {
    const missingCriteria = ProposePlanInputSchema.safeParse({
      summary: "s",
      tasks: [
        {
          id: "t1",
          title: "t",
          description: "d",
          dependsOn: [],
          acceptanceCriteriaIds: [],
          harness: "codex",
          harnessConfig: { reasoning: "medium", sandbox: "workspace-write" },
        },
      ],
    });
    expect(missingCriteria.success).toBe(false);

    const missingConfig = ProposePlanInputSchema.safeParse({
      summary: "s",
      tasks: [
        {
          id: "t1",
          title: "t",
          description: "d",
          dependsOn: [],
          acceptanceCriteriaIds: ["ac1"],
          harness: "codex",
          harnessConfig: { reasoning: "medium" },
        },
      ],
    });
    expect(missingConfig.success).toBe(false);
  });
});
