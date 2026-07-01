import { z } from "zod";

// Matches the assignment's example config shape exactly:
// { "fields": [{ "path": "...", "from": "...", "type": "...", "normalize": "...", "required": bool }],
//   "include_confidence": bool, "on_missing": "null" | "omit" | "error" }

export const FieldConfig = z.object({
  path: z.string(), // output field name/path, e.g. "primary_email"
  from: z.string(), // canonical source path, e.g. "emails[0]" or "skills[].name"
  type: z.enum(["string", "number", "boolean", "string[]", "number[]", "object"]),
  required: z.boolean().optional().default(false),
  normalize: z.enum(["E164", "canonical", "none"]).optional().default("none"),
});
export type FieldConfig = z.infer<typeof FieldConfig>;

export const ProjectionConfig = z.object({
  fields: z.array(FieldConfig),
  include_confidence: z.boolean().default(false),
  on_missing: z.enum(["null", "omit", "error"]).default("null"),
});
export type ProjectionConfig = z.infer<typeof ProjectionConfig>;

// The default config: every canonical field, no renames, confidence+provenance on,
// missing values become null. This is the "starting point, yours to refine" schema
// from the spec, expressed as a ProjectionConfig so the SAME projection engine
// handles both the default and custom cases — no special-casing.
export const DEFAULT_CONFIG: ProjectionConfig = {
  fields: [
    { path: "candidate_id", from: "candidate_id", type: "string", required: true, normalize: "none" },
    { path: "full_name", from: "full_name", type: "string", required: true, normalize: "none" },
    { path: "emails", from: "emails", type: "string[]", required: false, normalize: "none" },
    { path: "phones", from: "phones", type: "string[]", required: false, normalize: "none" },
    { path: "location", from: "location", type: "object", required: false, normalize: "none" },
    { path: "headline", from: "headline", type: "string", required: false, normalize: "none" },
    { path: "years_experience", from: "years_experience", type: "number", required: false, normalize: "none" },
    { path: "skills", from: "skills[].name", type: "string[]", required: false, normalize: "canonical" },
  ],
  include_confidence: true,
  on_missing: "null",
};
