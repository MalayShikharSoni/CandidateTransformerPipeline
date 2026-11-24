import type { Candidate, OutputRecord, ProvenanceEntry, SourceName } from "./types";

/** The ten canonical fields a profile can fill, for the coverage figure. */
export const PROFILE_FIELDS = [
  "full_name",
  "emails",
  "phones",
  "location",
  "links",
  "headline",
  "years_experience",
  "skills",
  "experience",
  "education",
] as const;

export function isCandidate(record: OutputRecord): record is Candidate & Record<string, unknown> {
  return (
    !("error" in record) &&
    typeof record.candidate_id === "string" &&
    typeof record.full_name === "string" &&
    Array.isArray(record.emails)
  );
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasValue);
  return true;
}

export function coverage(candidate: Candidate): { filled: number; total: number } {
  const record = candidate as unknown as Record<string, unknown>;
  return {
    filled: PROFILE_FIELDS.filter((field) => hasValue(record[field])).length,
    total: PROFILE_FIELDS.length,
  };
}

export function sourcesOf(candidate: Candidate): Set<SourceName> {
  return new Set((candidate.provenance ?? []).map((entry) => entry.source));
}

/** C R G letters for the results table, a dot for a source that added nothing. */
export function sourceLetters(candidate: Candidate): string {
  const used = sourcesOf(candidate);
  return [
    used.has("csv") ? "C" : "·",
    used.has("resume") ? "R" : "·",
    used.has("github") ? "G" : "·",
  ].join(" ");
}

export function meter(value: number | null | undefined, width = 10): string {
  if (value === null || value === undefined) return "·".repeat(width);
  const on = Math.max(0, Math.min(width, Math.round(value * width)));
  return "█".repeat(on) + "░".repeat(width - on);
}

/** Provenance entries for a field and its sub-paths (links.github belongs to links). */
export function provenanceFor(candidate: Candidate, field: string): ProvenanceEntry[] {
  return (candidate.provenance ?? []).filter(
    (entry) => entry.field === field || entry.field.startsWith(`${field}.`),
  );
}

export function monthIndex(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  return year * 12 + (month - 1);
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
