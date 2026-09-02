/**
 * Zod → JSON Schema for strict tool definitions.
 *
 * The SDK ships `transformJSONSchema`, but it demotes every keyword it does
 * not recognise — including `enum` and `const` — into a prose description,
 * which is exactly the constraint we want the model to be held to. So we do
 * the (small) walk ourselves: keep the schema as zod emitted it, drop the
 * `$schema` marker, and force `additionalProperties: false` on every object,
 * which is what `strict: true` requires.
 */
import { z } from "zod";

export type JsonSchemaObject = Record<string, unknown>;

function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (node === null || typeof node !== "object") return node;

  const source = node as JsonSchemaObject;
  const out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") continue;
    out[key] = harden(value);
  }
  if (out.type === "object") {
    out.additionalProperties = false;
    if (!("properties" in out)) out.properties = {};
  }
  return out;
}

/**
 * Convert a zod object schema into a JSON Schema suitable for a strict tool
 * (`additionalProperties: false` everywhere, no `$schema`, `required` listing
 * exactly the non-optional keys).
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const raw = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as JsonSchemaObject;
  const hardened = harden(raw) as JsonSchemaObject;
  if (hardened.type !== "object") {
    throw new Error("a tool input schema must be an object schema");
  }
  return hardened;
}
