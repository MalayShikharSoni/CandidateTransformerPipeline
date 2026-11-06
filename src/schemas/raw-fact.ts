import { z } from "zod";

// The common intermediate shape every source gets mapped into during 'extract'.
// This is what makes downstream stages (normalize, merge) source-agnostic in their
// processing logic, while still carrying enough metadata (source, sourceMethod) to
// reconstruct full provenance later.
export const RawFact = z.object({
  field: z.string(), // canonical field name this fact contributes to, e.g. "full_name", "phones"
  rawValue: z.unknown(), // the untransformed value as read from the source
  source: z.enum(["csv", "github"]),
  sourceMethod: z.string(), // e.g. "csv_column:phone", "github_field:bio"
  rowIndex: z.number().int().nonnegative(), // source-local bundle id (CSV row index or GitHub call index)
  // true when the CSV row itself named this GitHub username (github_username column).
  // That link is explicit evidence, so merge trusts it even if the names differ.
  rowLinked: z.boolean().optional(),
});
export type RawFact = z.infer<typeof RawFact>;

// Produced by the 'normalize' stage — a RawFact plus its normalized value (or null
// if normalization failed) and whether normalization actually ran/succeeded.
export interface NormalizedFact extends RawFact {
  normalizedValue: unknown | null;
  normalizationSucceeded: boolean;
}
