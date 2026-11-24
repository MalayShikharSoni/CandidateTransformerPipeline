import { isPresentWord, normalizeDate } from "./date.js";

// Normalizers for whole entries (one job, one degree) that a resume yields as a
// single fact. Each returns the cleaned entry, or null when the entry has
// nothing usable, plus whether every value that was given also parsed.

export interface NormalizedExperienceEntry {
  company: string | null;
  title: string | null;
  start: string | null; // YYYY-MM
  end: string | null; // YYYY-MM, null when ongoing or not stated
  /** true when the resume said the role is ongoing ("Present"). */
  current: boolean;
}

export interface NormalizedEducationEntry {
  institution: string;
  degree: string | null;
  field: string | null;
  end_year: number | null;
}

export interface EntryResult<T> {
  value: T | null;
  /** false when a value was given but could not be parsed (e.g. a date "Spring '21"). */
  succeeded: boolean;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function record(rawValue: unknown): Record<string, unknown> | null {
  return typeof rawValue === "object" && rawValue !== null
    ? (rawValue as Record<string, unknown>)
    : null;
}

export function normalizeExperienceEntry(
  rawValue: unknown,
): EntryResult<NormalizedExperienceEntry> {
  const raw = record(rawValue);
  const company = text(raw?.company);
  const title = text(raw?.title);
  if (raw === null || (company === null && title === null)) {
    return { value: null, succeeded: false };
  }

  const rawStart = text(raw.start);
  const rawEnd = text(raw.end);
  const start = normalizeDate(rawStart);
  const current = isPresentWord(rawEnd);
  const end = current ? null : normalizeDate(rawEnd);

  const startFailed = rawStart !== null && start === null;
  const endFailed = rawEnd !== null && !current && end === null;

  return {
    value: { company, title, start, end, current },
    succeeded: !startFailed && !endFailed,
  };
}

export function normalizeEducationEntry(
  rawValue: unknown,
): EntryResult<NormalizedEducationEntry> {
  const raw = record(rawValue);
  const institution = text(raw?.institution);
  if (raw === null || institution === null) {
    return { value: null, succeeded: false };
  }

  const rawYear = raw.end_year;
  const yearGiven = rawYear !== null && rawYear !== undefined;
  const year =
    typeof rawYear === "number" && Number.isInteger(rawYear) && rawYear >= 1900 && rawYear <= 2100
      ? rawYear
      : null;

  return {
    value: { institution, degree: text(raw.degree), field: text(raw.field), end_year: year },
    succeeded: !yearGiven || year !== null,
  };
}
