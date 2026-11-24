import { z } from "zod";

// Every source the pipeline reads, in no particular order. Precedence lives in
// merge/resolve.ts (SOURCE_PRECEDENCE).
export const SourceName = z.enum(["csv", "resume", "github"]);
export type SourceName = z.infer<typeof SourceName>;

// The common intermediate shape every source gets mapped into during 'extract'.
// This is what makes downstream stages (normalize, merge) source-agnostic in their
// processing logic, while still carrying enough metadata (source, sourceMethod) to
// reconstruct full provenance later.
export const RawFact = z.object({
  field: z.string(), // canonical field name this fact contributes to, e.g. "full_name", "phones"
  rawValue: z.unknown(), // the untransformed value as read from the source
  source: SourceName,
  sourceMethod: z.string(), // e.g. "csv_column:phone", "github_field:bio"
  rowIndex: z.number().int().nonnegative(), // the CSV row this fact belongs to (GitHub and resume facts are stamped with it)
  // true when the CSV row itself named this source (github_username or resume_path
  // column). That link is explicit evidence, so merge trusts it even if the names differ.
  rowLinked: z.boolean().optional(),
});
export type RawFact = z.infer<typeof RawFact>;

// Produced by the 'normalize' stage — a RawFact plus its normalized value (or null
// if normalization failed) and whether normalization actually ran/succeeded.
export interface NormalizedFact extends RawFact {
  normalizedValue: unknown; // null when normalization failed
  normalizationSucceeded: boolean;
}
