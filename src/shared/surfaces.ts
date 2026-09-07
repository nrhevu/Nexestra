import { z } from "zod";

const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const SurfaceFieldSchema = z
  .object({
    key: FieldKey,
    label: z.string().trim().min(1).max(80),
    type: z.enum(["text", "long_text", "number", "select", "url", "checkbox"]),
    options: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  })
  .strict();
export const SurfaceManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    pluginId: z.string().regex(/^[a-z][a-z0-9-]{1,31}\.[a-z][a-z0-9-]{1,47}$/),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(20),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(""),
    view: z.enum(["table", "board", "canvas", "document"]),
    titleField: FieldKey,
    bodyField: FieldKey.optional(),
    groupBy: FieldKey.optional(),
    fields: z.array(SurfaceFieldSchema).min(1).max(8),
  })
  .strict()
  .superRefine((manifest, context) => {
    const fields = new Map(manifest.fields.map((field) => [field.key, field]));
    if (fields.size !== manifest.fields.length)
      context.addIssue({ code: "custom", message: "Field keys must be unique." });
    if (!["text", "long_text"].includes(fields.get(manifest.titleField)?.type ?? ""))
      context.addIssue({ code: "custom", message: "titleField must name a text field." });
    if (
      manifest.bodyField &&
      !["text", "long_text"].includes(fields.get(manifest.bodyField)?.type ?? "")
    )
      context.addIssue({ code: "custom", message: "bodyField must name a text field." });
    if (
      manifest.view === "board" &&
      (!manifest.groupBy || fields.get(manifest.groupBy)?.type !== "select")
    )
      context.addIssue({
        code: "custom",
        message: "A board needs groupBy pointing to a select field.",
      });
    for (const field of manifest.fields)
      if (
        field.type === "select" &&
        (!field.options?.length || new Set(field.options).size !== field.options.length)
      )
        context.addIssue({
          code: "custom",
          message: `Select field ${field.key} needs distinct options.`,
        });
  });
export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;
export type SurfaceField = z.infer<typeof SurfaceFieldSchema>;
export const SurfaceDataSchema = z.record(
  FieldKey,
  z.union([z.string().max(12_000), z.number().finite().min(-1e12).max(1e12), z.boolean()]),
);
export const SurfacePositionSchema = z
  .object({ x: z.number().min(0).max(2000), y: z.number().min(0).max(1600) })
  .strict();
export const SurfaceColorSchema = z.enum(["lilac", "blue", "green", "yellow", "rose"]);
const RecordContentSchema = z
  .object({
    data: SurfaceDataSchema,
    position: SurfacePositionSchema.default({ x: 40, y: 40 }),
    color: SurfaceColorSchema.default("lilac"),
  })
  .strict();
const ActorSchema = z.object({ kind: z.enum(["user", "agent"]), id: z.string() });
export const SurfaceRecordSchema = RecordContentSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  archived: z.boolean().default(false),
  updatedAt: z.string(),
  updatedBy: ActorSchema,
});
export type SurfaceRecord = z.infer<typeof SurfaceRecordSchema>;
export const WorkspaceSurfaceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  manifest: SurfaceManifestSchema,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  records: z.array(SurfaceRecordSchema).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: ActorSchema,
});
export type WorkspaceSurface = z.infer<typeof WorkspaceSurfaceSchema>;
export const CreateSurfaceSchema = z
  .object({
    workspaceId: z.string().optional(),
    manifest: SurfaceManifestSchema,
    records: z.array(RecordContentSchema).max(100).default([]),
  })
  .strict()
  .refine(
    (input) => JSON.stringify(input).length <= 400_000,
    "Surface data must fit within 400,000 characters.",
  );
export const UpdateSurfaceSchema = z
  .object({ expectedRevision: z.number().int().positive(), manifest: SurfaceManifestSchema })
  .strict();
export const SetSurfaceEnabledSchema = z
  .object({ expectedRevision: z.number().int().positive(), enabled: z.boolean() })
  .strict();
export const SaveSurfaceRecordSchema = z
  .object({
    data: SurfaceDataSchema,
    position: SurfacePositionSchema.optional(),
    color: SurfaceColorSchema.optional(),
    expectedRevision: z.number().int().positive(),
    id: z.string().uuid().optional(),
  })
  .strict();
export type SaveSurfaceRecordInput = z.infer<typeof SaveSurfaceRecordSchema>;
export type CreateSurfaceInput = z.input<typeof CreateSurfaceSchema>;
export const ArchiveSurfaceRecordSchema = z
  .object({ expectedRevision: z.number().int().positive(), archived: z.boolean() })
  .strict();
export const SurfaceContextQuerySchema = z
  .object({ recordIds: z.array(z.string().uuid()).max(20).default([]) })
  .strict();

export function surfaceDataError(
  manifest: SurfaceManifest,
  data: SurfaceRecord["data"],
): string | undefined {
  const fields = new Map(manifest.fields.map((field) => [field.key, field]));
  if (typeof data[manifest.titleField] !== "string" || !String(data[manifest.titleField]).trim())
    return "Every record needs a nonblank title.";
  if (String(data[manifest.titleField]).length > 160)
    return "Record titles must be no longer than 160 characters.";
  for (const [key, value] of Object.entries(data)) {
    const field = fields.get(key);
    if (!field) return `Unknown field ${key}. Use fields declared by the surface manifest.`;
    if (field.type === "number" && typeof value !== "number")
      return `${field.label} must be a number.`;
    if (field.type === "checkbox" && typeof value !== "boolean")
      return `${field.label} must be true or false.`;
    if (!["number", "checkbox"].includes(field.type) && typeof value !== "string")
      return `${field.label} must be text.`;
    if (field.type === "select" && value !== "" && !field.options?.includes(String(value)))
      return `${field.label} must use one of its declared options.`;
    if (field.type === "url" && value !== "") {
      try {
        const url = new URL(String(value));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          return `${field.label} must be an HTTP(S) URL without credentials.`;
      } catch {
        return `${field.label} must be a valid URL.`;
      }
    }
  }
  return undefined;
}

export function surfaceContext(surface: WorkspaceSurface, recordIds: string[] = []) {
  const selected = new Set(recordIds);
  const eligible = surface.records.filter(
    (record) => !record.archived && (selected.size === 0 || selected.has(record.id)),
  );
  const records: {
    id: string;
    revision: number;
    data: SurfaceRecord["data"];
    position: SurfaceRecord["position"];
  }[] = [];
  let characters = 0;
  let shortened = false;
  for (const record of eligible) {
    if (records.length >= 20) break;
    const data = Object.fromEntries(
      Object.entries(record.data).map(([key, value]) => {
        if (typeof value === "string" && value.length > 1200) {
          shortened = true;
          return [key, `${value.slice(0, 1199)}…`];
        }
        return [key, value];
      }),
    );
    const item = { id: record.id, revision: record.revision, data, position: record.position };
    const size = JSON.stringify(item).length;
    if (characters + size > 10_000) break;
    records.push(item);
    characters += size;
  }
  return {
    surfaceId: surface.id,
    revision: surface.revision,
    name: surface.manifest.name,
    view: surface.manifest.view,
    meaning:
      "These are workspace notes and records. They do not set task acceptance or grant execution permission.",
    fields: surface.manifest.fields,
    records,
    truncated: shortened || records.length < eligible.length,
  };
}

export function surfaceTemplate(view: SurfaceManifest["view"], name: string): SurfaceManifest {
  return SurfaceManifestSchema.parse({
    apiVersion: 1,
    pluginId: `local.${view}-notes`,
    version: "1.0.0",
    name,
    description:
      view === "canvas"
        ? "Arrange ideas and make shared understanding visible."
        : "A shared place for findings, ideas and decisions.",
    view,
    titleField: "title",
    bodyField: "notes",
    ...(view === "board" ? { groupBy: "stage" } : {}),
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "notes", label: "Notes", type: "long_text" },
      ...(view === "board"
        ? [
            {
              key: "stage",
              label: "Stage",
              type: "select",
              options: ["Explore", "Discuss", "Decided"],
            },
          ]
        : [{ key: "source", label: "Source", type: "url" }]),
    ],
  });
}
