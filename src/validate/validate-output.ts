import { z } from "zod";
import { CanonicalCandidate, ProvenanceEntry } from "../schemas/canonical.js";
import type { FieldConfig, ProjectionConfig } from "../schemas/config.js";

const TOP_LEVEL_FIELD = /^[a-zA-Z_]\w*$/;

/**
 * When a field is copied straight from a top-level canonical field
 * (e.g. from: "links"), reuse that field's schema from the canonical model,
 * so objects are checked key by key instead of just "is an object".
 */
function canonicalSchemaFor(from: string): z.ZodTypeAny | null {
  if (!TOP_LEVEL_FIELD.test(from)) {
    return null;
  }
  const shape = CanonicalCandidate.shape as Record<string, z.ZodTypeAny>;
  return shape[from] ?? null;
}

function baseSchemaForType(field: FieldConfig): z.ZodTypeAny {
  switch (field.type) {
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
      return canonicalSchemaFor(field.from) ?? z.record(z.string(), z.unknown());
    case "object[]":
      return (
        canonicalSchemaFor(field.from) ?? z.array(z.record(z.string(), z.unknown()))
      );
  }
}

function fieldSchema(
  field: FieldConfig,
  onMissing: ProjectionConfig["on_missing"],
): z.ZodTypeAny {
  const base = baseSchemaForType(field);

  if (onMissing === "omit") {
    return base.optional();
  }

  return base.nullable();
}

export function buildOutputSchema(config: ProjectionConfig): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of config.fields) {
    shape[field.path] = fieldSchema(field, config.on_missing);
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

  return { ok: true, data: result.data };
}
