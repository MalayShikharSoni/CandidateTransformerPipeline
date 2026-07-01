import { z } from "zod";
import { ProvenanceEntry } from "../schemas/canonical.js";
import type { FieldConfig, ProjectionConfig } from "../schemas/config.js";

function baseSchemaForType(type: FieldConfig["type"]): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "string[]":
      return z.array(z.union([z.string(), z.null()]));
    case "number[]":
      return z.array(z.number());
    case "object":
      // Currently only location uses type: 'object' — if additional object-typed
      // fields are added, extend this case rather than relying on a single hardcoded schema.
      return z.object({
        city: z.string().nullable(),
        region: z.string().nullable(),
        country: z.string().nullable(),
      });
  }
}

function fieldSchema(
  type: FieldConfig["type"],
  onMissing: ProjectionConfig["on_missing"],
): z.ZodTypeAny {
  const base = baseSchemaForType(type);

  if (onMissing === "omit") {
    return base.optional();
  }

  return base.nullable();
}

export function buildOutputSchema(config: ProjectionConfig): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of config.fields) {
    shape[field.path] = fieldSchema(field.type, config.on_missing);
  }

  if (config.include_confidence) {
    shape.overall_confidence = z.number().min(0).max(1);
    shape.provenance = z.array(ProvenanceEntry);
  }

  return z.object(shape).strict();
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Validation failed: unknown schema error";
  }

  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `Validation failed: ${path} — ${issue.message}`;
}

export function validateProjectedOutput(
  output: Record<string, unknown>,
  config: ProjectionConfig,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string } {
  const schema = buildOutputSchema(config);
  const result = schema.safeParse(output);

  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }

  return { ok: true, data: result.data as Record<string, unknown> };
}
