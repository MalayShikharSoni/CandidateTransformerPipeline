import type { NormalizedFact, RawFact } from "../schemas/raw-fact.js";
import {
  normalizeEducationEntry,
  normalizeExperienceEntry,
  type EntryResult,
} from "./entries.js";
import { normalizePhone } from "./phone.js";
import { normalizeSkill } from "./skills.js";

type FieldNormalizer = (rawValue: unknown) => string | null;

/** Fields that run a dedicated normalizer. */
const NORMALIZER_BY_FIELD: Readonly<Record<string, FieldNormalizer>> = {
  phones: normalizePhone,
  skills: normalizeSkill,
};

/** Fields whose value is a whole entry (one job, one degree) from a resume. */
const ENTRY_NORMALIZER_BY_FIELD: Readonly<
  Record<string, (rawValue: unknown) => EntryResult<unknown>>
> = {
  "experience.entry": normalizeExperienceEntry,
  "education.entry": normalizeEducationEntry,
};

/** Fields that intentionally skip normalization — value is used as-is. */
const PASSTHROUGH_FIELDS: ReadonlySet<string> = new Set([
  "full_name",
  "emails",
  "headline",
  "links.github",
  "links.linkedin",
  "links.portfolio",
  "experience.company",
  "experience.title",
]);

function normalizeFact(fact: RawFact): NormalizedFact {
  // An entry keeps its cleaned value even when one of its dates failed to parse;
  // normalizationSucceeded=false then halves its confidence, as for any field.
  const entryNormalizer = ENTRY_NORMALIZER_BY_FIELD[fact.field];
  if (entryNormalizer !== undefined) {
    const { value, succeeded } = entryNormalizer(fact.rawValue);
    return { ...fact, normalizedValue: value, normalizationSucceeded: succeeded };
  }

  const normalizer = NORMALIZER_BY_FIELD[fact.field];

  if (normalizer !== undefined) {
    const normalizedValue = normalizer(fact.rawValue);
    return {
      ...fact,
      normalizedValue,
      normalizationSucceeded: normalizedValue !== null,
    };
  }

  if (PASSTHROUGH_FIELDS.has(fact.field)) {
    return {
      ...fact,
      normalizedValue: fact.rawValue,
      normalizationSucceeded: true,
    };
  }

  return {
    ...fact,
    normalizedValue: fact.rawValue,
    normalizationSucceeded: false,
  };
}

export function normalizeFacts(facts: RawFact[]): NormalizedFact[] {
  return facts.map(normalizeFact);
}
