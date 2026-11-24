import type {
  CanonicalCandidate,
  EducationEntry,
  ExperienceEntry,
  ProvenanceEntry,
  ProvenanceMethod,
  Skill,
} from "../schemas/canonical.js";
import { normalizeCountry } from "../normalizers/country.js";
import type {
  NormalizedEducationEntry,
  NormalizedExperienceEntry,
} from "../normalizers/entries.js";
import type { NormalizedFact, SourceName } from "../schemas/raw-fact.js";
import type { CandidateFactGroup } from "./group.js";

// Highest precedence first. The recruiter's CSV wins; a resume (written by the
// candidate) beats a GitHub profile.
export const SOURCE_PRECEDENCE: readonly SourceName[] = ["csv", "resume", "github"];
type Source = SourceName;

interface ScalarCandidate {
  source: Source;
  fact: NormalizedFact;
  eligible: boolean;
  value: string | null;
  valueMethod: "direct" | "normalized";
}

export interface ResolvedScalarField {
  value: string | null;
  provenance: ProvenanceEntry | null;
  confidence: number | null;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function valuesEqual(a: string, b: string): boolean {
  return normalizeKeyPart(a) === normalizeKeyPart(b);
}

/** Resume facts the LLM extracted (after the grounding check), as opposed to regex. */
export function isLlmFact(fact: NormalizedFact): boolean {
  return fact.sourceMethod.startsWith("resume_llm:");
}

// Base confidence by how a fact was obtained: the recruiter's own CSV, a regex
// match on a fixed format in the resume, a public profile, or the LLM reading
// resume layout.
function factBaseScore(fact: NormalizedFact): number {
  switch (fact.source) {
    case "csv":
      return 0.9;
    case "resume":
      return isLlmFact(fact) ? 0.5 : 0.8;
    case "github":
      return 0.6;
  }
}

export function factScore(fact: NormalizedFact): number {
  return factBaseScore(fact) * (fact.normalizationSucceeded ? 1 : 0.5);
}

/** The highest-precedence source in the set. */
function topSource(sources: Iterable<Source>): Source {
  const present = new Set(sources);
  return SOURCE_PRECEDENCE.find((source) => present.has(source)) ?? "csv";
}

function ranNormalizer(field: string): boolean {
  return field === "phones" || field === "skills";
}

function toScalarCandidate(fact: NormalizedFact): ScalarCandidate {
  const normalizedString =
    typeof fact.normalizedValue === "string" ? fact.normalizedValue : null;

  const eligible =
    fact.normalizationSucceeded &&
    normalizedString !== null &&
    normalizedString.trim() !== "";

  const value = eligible ? normalizedString.trim() : null;

  let valueMethod: "direct" | "normalized" = "direct";
  if (
    eligible &&
    ranNormalizer(fact.field) &&
    typeof fact.rawValue === "string" &&
    fact.normalizedValue !== fact.rawValue
  ) {
    valueMethod = "normalized";
  }

  return {
    source: fact.source,
    fact,
    eligible,
    value,
    valueMethod,
  };
}

function candidatesForField(
  facts: NormalizedFact[],
  field: string,
): Partial<Record<Source, ScalarCandidate>> {
  const candidates: Partial<Record<Source, ScalarCandidate>> = {};

  for (const fact of facts) {
    if (fact.field !== field) {
      continue;
    }
    if (candidates[fact.source] !== undefined) {
      continue;
    }
    candidates[fact.source] = toScalarCandidate(fact);
  }

  return candidates;
}

function scalarProvenanceMethod(
  winner: ScalarCandidate,
  conflict: boolean,
  matchKey: string,
): ProvenanceMethod {
  if (conflict) {
    return "precedence_override_conflict";
  }
  if (matchKey.startsWith("name+company:")) {
    return "fallback_match";
  }
  if (isLlmFact(winner.fact)) {
    return "llm_extracted";
  }
  return winner.valueMethod;
}

function eligibleValues(
  candidates: Partial<Record<Source, ScalarCandidate>>,
): Array<{ source: Source; value: string }> {
  const values: Array<{ source: Source; value: string }> = [];
  for (const source of SOURCE_PRECEDENCE) {
    const candidate = candidates[source];
    if (candidate?.eligible === true && candidate.value !== null) {
      values.push({ source, value: candidate.value });
    }
  }
  return values;
}

/** true when another source gives the same value as the winner. */
function otherSourceAgrees(
  candidates: Partial<Record<Source, ScalarCandidate>>,
  winner: ScalarCandidate,
): boolean {
  return eligibleValues(candidates).some(
    ({ source, value }) =>
      source !== winner.source && winner.value !== null && valuesEqual(value, winner.value),
  );
}

/** true when another source gives a valid value that differs from the winner's. */
function otherSourceDisagrees(
  candidates: Partial<Record<Source, ScalarCandidate>>,
  winner: ScalarCandidate,
): boolean {
  return eligibleValues(candidates).some(
    ({ source, value }) =>
      source !== winner.source && winner.value !== null && !valuesEqual(value, winner.value),
  );
}

export function resolveScalarField(
  facts: NormalizedFact[],
  field: string,
  matchKey: string,
): ResolvedScalarField {
  const candidates = candidatesForField(facts, field);

  let winner: ScalarCandidate | null = null;
  for (const source of SOURCE_PRECEDENCE) {
    const candidate = candidates[source];
    if (candidate?.eligible === true) {
      winner = candidate;
      break;
    }
  }

  if (winner === null) {
    return { value: null, provenance: null, confidence: null };
  }

  const conflict = otherSourceDisagrees(candidates, winner);
  const confidence = Math.min(
    1,
    factScore(winner.fact) + (otherSourceAgrees(candidates, winner) ? 0.1 : 0),
  );

  return {
    value: winner.value,
    provenance: {
      field,
      source: winner.source,
      method: scalarProvenanceMethod(winner, conflict, matchKey),
    },
    confidence,
  };
}

export interface ResolvedArrayField {
  values: string[];
  provenance: ProvenanceEntry | null;
  confidence: number | null;
}

function collectEligibleValues(facts: NormalizedFact[], field: string): {
  values: string[];
  contributors: Set<Source>;
  usedNormalization: boolean;
} {
  const contributors = new Set<Source>();
  let usedNormalization = false;
  const valuesBySource = new Map<Source, Set<string>>();

  for (const source of SOURCE_PRECEDENCE) {
    valuesBySource.set(source, new Set());
  }

  for (const fact of facts) {
    if (fact.field !== field) {
      continue;
    }

    const candidate = toScalarCandidate(fact);
    if (!candidate.eligible || candidate.value === null) {
      continue;
    }

    contributors.add(fact.source);
    valuesBySource.get(fact.source)?.add(candidate.value);

    if (candidate.valueMethod === "normalized") {
      usedNormalization = true;
    }
  }

  const values: string[] = [];
  const seen = new Set<string>();

  for (const source of SOURCE_PRECEDENCE) {
    for (const value of valuesBySource.get(source) ?? []) {
      const dedupeKey =
        field === "emails" ? normalizeKeyPart(value) : value;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      values.push(value);
    }
  }

  return { values, contributors, usedNormalization };
}

function failedNormalizationFacts(
  facts: NormalizedFact[],
  field: string,
): NormalizedFact[] {
  return facts.filter(
    (fact) =>
      fact.field === field &&
      ranNormalizer(fact.field) &&
      !fact.normalizationSucceeded,
  );
}

function arrayProvenanceForFailedNormalization(
  facts: NormalizedFact[],
  field: string,
): ProvenanceEntry | null {
  const failedFacts = failedNormalizationFacts(facts, field);
  if (failedFacts.length === 0) {
    return null;
  }

  for (const source of SOURCE_PRECEDENCE) {
    const fact = failedFacts.find((entry) => entry.source === source);
    if (fact !== undefined) {
      return {
        field,
        source,
        method: "normalization_failed",
      };
    }
  }

  return {
    field,
    source: failedFacts[0].source,
    method: "normalization_failed",
  };
}

// Arrays are always union — never precedence picks. precedence_override_conflict
// applies only to scalar fields where two values compete for one slot.
function arrayProvenanceMethod(
  usedNormalization: boolean,
  matchKey: string,
  fromLlmOnly: boolean,
): ProvenanceMethod {
  if (matchKey.startsWith("name+company:")) {
    return "fallback_match";
  }
  if (fromLlmOnly) {
    return "llm_extracted";
  }
  return usedNormalization ? "normalized" : "direct";
}

function arrayFieldConfidence(
  facts: NormalizedFact[],
  field: string,
): number | null {
  const scoresBySource = new Map<Source, number>();
  const valuesBySource = new Map<Source, Set<string>>();
  let hasEligibleValue = false;

  for (const source of SOURCE_PRECEDENCE) {
    valuesBySource.set(source, new Set());
  }

  for (const fact of facts) {
    if (fact.field !== field) {
      continue;
    }

    const candidate = toScalarCandidate(fact);
    scoresBySource.set(
      fact.source,
      Math.max(scoresBySource.get(fact.source) ?? 0, factScore(fact)),
    );

    if (candidate.eligible && candidate.value !== null) {
      hasEligibleValue = true;
      valuesBySource.get(fact.source)?.add(candidate.value);
    }
  }

  if (!hasEligibleValue) {
    return null;
  }

  const contributingScores = [...scoresBySource.entries()]
    .filter(([source]) => (valuesBySource.get(source)?.size ?? 0) > 0)
    .map(([, score]) => score);

  const maxScore =
    contributingScores.length > 0 ? Math.max(...contributingScores) : 0;

  // +0.1 when two different sources share at least one value.
  const sources = [...valuesBySource.entries()];
  const sharedValue = sources.some(([source, values]) =>
    sources.some(
      ([otherSource, otherValues]) =>
        otherSource !== source &&
        [...values].some((value) => [...otherValues].some((other) => valuesEqual(value, other))),
    ),
  );

  return Math.min(1, maxScore + (sharedValue ? 0.1 : 0));
}

function experienceFieldConfidence(facts: NormalizedFact[]): number | null {
  const experienceFacts = facts.filter(
    (fact) =>
      fact.field === "experience.company" ||
      fact.field === "experience.title" ||
      fact.field === "experience.entry",
  );

  let hasEligibleValue = false;
  const scoresBySource = new Map<Source, number>();

  for (const fact of experienceFacts) {
    const eligible =
      fact.field === "experience.entry"
        ? fact.normalizedValue !== null
        : toScalarCandidate(fact).eligible;
    scoresBySource.set(
      fact.source,
      Math.max(scoresBySource.get(fact.source) ?? 0, factScore(fact)),
    );
    if (eligible) {
      hasEligibleValue = true;
    }
  }

  if (!hasEligibleValue) {
    return null;
  }

  return Math.min(1, Math.max(...scoresBySource.values()));
}

export function resolveArrayField(
  facts: NormalizedFact[],
  field: string,
  matchKey: string,
): ResolvedArrayField {
  const { values, contributors, usedNormalization } =
    collectEligibleValues(facts, field);

  if (values.length === 0) {
    return {
      values: [],
      provenance: arrayProvenanceForFailedNormalization(facts, field),
      confidence: null,
    };
  }

  const source = topSource(contributors);
  const fromLlmOnly = facts
    .filter((fact) => fact.field === field && fact.source === source)
    .every(isLlmFact);

  return {
    values,
    provenance: {
      field,
      source,
      method: arrayProvenanceMethod(usedNormalization, matchKey, fromLlmOnly),
    },
    confidence: arrayFieldConfidence(facts, field),
  };
}

// Each skill gets its own sources and confidence: "TypeScript" seen in both CSV
// and GitHub should score higher than "Python" seen only in one GitHub repo.
// Same scoring rule as every other field: best source score, +0.1 if both agree.
export function resolveSkillEntries(
  facts: NormalizedFact[],
  orderedNames: string[],
): Skill[] {
  return orderedNames.map((name) => {
    const matching = facts.filter((fact) => {
      if (fact.field !== "skills") {
        return false;
      }
      const candidate = toScalarCandidate(fact);
      return candidate.eligible && candidate.value === name;
    });

    const sources = SOURCE_PRECEDENCE.filter((source) =>
      matching.some((fact) => fact.source === source),
    );
    const bestScore = Math.max(0, ...matching.map((fact) => factScore(fact)));
    const agreementBonus = sources.length > 1 ? 0.1 : 0;

    return {
      name,
      confidence: Math.min(1, bestScore + agreementBonus),
      sources: [...sources],
    };
  });
}

function bundleKey(fact: NormalizedFact): string {
  return `${fact.source}:${fact.rowIndex}`;
}

function sourceProvenanceMethod(
  matchKey: string,
  sourceFacts: NormalizedFact[],
): ProvenanceMethod {
  if (matchKey.startsWith("name+company:")) {
    return "fallback_match";
  }
  if (sourceFacts.length > 0 && sourceFacts.every(isLlmFact)) {
    return "llm_extracted";
  }
  return "direct";
}

/** One provenance entry per source that contributed, highest precedence first. */
function perSourceProvenance(
  field: string,
  usedFacts: NormalizedFact[],
  matchKey: string,
): ProvenanceEntry[] {
  return SOURCE_PRECEDENCE.flatMap((source) => {
    const sourceFacts = usedFacts.filter((fact) => fact.source === source);
    if (sourceFacts.length === 0) {
      return [];
    }
    return [{ field, source, method: sourceProvenanceMethod(matchKey, sourceFacts) }];
  });
}

export interface ResolvedListField<T> {
  entries: T[];
  provenance: ProvenanceEntry[];
  confidence: number | null;
}

// experience[] is a list, so sources add entries instead of competing:
// - CSV gives company + title as two facts; each CSV row becomes one entry.
// - A resume gives whole entries (experience.entry), already date-normalized.
// A resume entry whose company exactly equals a CSV entry's company (case and
// spacing aside, no fuzzy matching) is the same job: the CSV company and title
// win and the resume adds the dates. Every other resume entry is appended.
export function resolveExperience(
  facts: NormalizedFact[],
  matchKey: string,
): ResolvedListField<ExperienceEntry> {
  const byBundle = new Map<string, NormalizedFact[]>();

  for (const fact of facts) {
    if (fact.field !== "experience.company" && fact.field !== "experience.title") {
      continue;
    }

    const key = bundleKey(fact);
    const bucket = byBundle.get(key);
    if (bucket === undefined) {
      byBundle.set(key, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  const entries: ExperienceEntry[] = [];
  const bundleEntries: ExperienceEntry[] = [];
  const usedFacts: NormalizedFact[] = [];

  for (const bundleFacts of byBundle.values()) {
    const company = resolveScalarField(bundleFacts, "experience.company", matchKey);
    const title = resolveScalarField(bundleFacts, "experience.title", matchKey);

    const companyValue = company.value ?? "";
    const titleValue = title.value ?? "";

    if (companyValue === "" && titleValue === "") {
      continue;
    }

    const entry: ExperienceEntry = {
      company: companyValue,
      title: titleValue,
      start: null,
      end: null,
      summary: null,
    };
    entries.push(entry);
    bundleEntries.push(entry);
    usedFacts.push(...bundleFacts);
  }

  for (const fact of facts) {
    if (fact.field !== "experience.entry" || fact.normalizedValue === null) {
      continue;
    }
    const job = fact.normalizedValue as NormalizedExperienceEntry;
    usedFacts.push(fact);

    const jobCompany = job.company;
    const sameJob =
      jobCompany === null
        ? undefined
        : bundleEntries.find(
            (entry) =>
              entry.start === null &&
              entry.end === null &&
              valuesEqual(entry.company, jobCompany),
          );

    if (sameJob !== undefined) {
      sameJob.start = job.start;
      sameJob.end = job.end;
    } else {
      entries.push({
        company: job.company ?? "",
        title: job.title ?? "",
        start: job.start,
        end: job.end,
        summary: null,
      });
    }
  }

  if (entries.length === 0) {
    return { entries: [], provenance: [], confidence: null };
  }

  return {
    entries,
    provenance: perSourceProvenance("experience", usedFacts, matchKey),
    confidence: experienceFieldConfidence(facts),
  };
}

export function resolveEducation(
  facts: NormalizedFact[],
  matchKey: string,
): ResolvedListField<EducationEntry> {
  const entries: EducationEntry[] = [];
  const usedFacts: NormalizedFact[] = [];
  const seen = new Set<string>();

  for (const fact of facts) {
    if (fact.field !== "education.entry" || fact.normalizedValue === null) {
      continue;
    }
    const school = fact.normalizedValue as NormalizedEducationEntry;
    const key = `${normalizeKeyPart(school.institution)}|${normalizeKeyPart(school.degree ?? "")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    usedFacts.push(fact);
    entries.push({
      institution: school.institution,
      degree: school.degree ?? "",
      field: school.field ?? "",
      end_year: school.end_year,
    });
  }

  if (entries.length === 0) {
    return { entries: [], provenance: [], confidence: null };
  }

  return {
    entries,
    provenance: perSourceProvenance("education", usedFacts, matchKey),
    confidence: Math.min(1, Math.max(...usedFacts.map(factScore))),
  };
}

function monthIndex(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  return year * 12 + (month - 1);
}

/**
 * Total time covered by dated jobs, in years (one decimal). Overlapping jobs
 * count once. An ongoing job ("Present") runs to `asOf` (YYYY-MM), which the
 * caller passes in so the result does not depend on the clock. A job with a
 * start but no stated end is left out rather than guessed. Null when no job
 * has usable dates.
 */
export function resolveYearsExperience(
  facts: NormalizedFact[],
  asOf: string | undefined,
): { value: number | null; provenance: ProvenanceEntry | null; confidence: number | null } {
  const intervals: Array<[number, number]> = [];
  const usedFacts: NormalizedFact[] = [];

  for (const fact of facts) {
    if (fact.field !== "experience.entry" || fact.normalizedValue === null) {
      continue;
    }
    const job = fact.normalizedValue as NormalizedExperienceEntry;
    const end = job.end ?? (job.current ? asOf : undefined);
    if (job.start === null || end === undefined) {
      continue;
    }
    const startIndex = monthIndex(job.start);
    const endIndex = monthIndex(end);
    if (endIndex < startIndex) {
      continue;
    }
    // Both ends are whole months: Jan 2020 - Mar 2020 is 3 months.
    intervals.push([startIndex, endIndex + 1]);
    usedFacts.push(fact);
  }

  if (intervals.length === 0) {
    return { value: null, provenance: null, confidence: null };
  }

  intervals.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [currentStart, currentEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      months += currentEnd - currentStart;
      [currentStart, currentEnd] = [start, end];
    }
  }
  months += currentEnd - currentStart;

  return {
    value: Math.round((months / 12) * 10) / 10,
    provenance: {
      field: "years_experience",
      source: topSource(usedFacts.map((fact) => fact.source)),
      method: "derived",
    },
    confidence: Math.min(...usedFacts.map(factScore)),
  };
}

function averageConfidence(scores: Array<number | null>): number {
  const populated = scores.filter((score): score is number => score !== null);
  if (populated.length === 0) {
    return 0;
  }
  return populated.reduce((sum, score) => sum + score, 0) / populated.length;
}

function resolveLocation(facts: NormalizedFact[]): {
  location: CanonicalCandidate["location"];
  provenance: ProvenanceEntry | null;
} {
  const empty = { city: null, region: null, country: null };

  const rawFact = facts.find(
    (fact) =>
      fact.field === "location.raw" &&
      typeof fact.rawValue === "string" &&
      fact.rawValue.trim() !== "",
  );
  // find() does not narrow rawValue from unknown, so check the type again here.
  if (rawFact === undefined || typeof rawFact.rawValue !== "string") {
    return { location: empty, provenance: null };
  }

  const raw = rawFact.rawValue.trim();
  const lastComma = raw.lastIndexOf(",");

  let location: CanonicalCandidate["location"];

  if (lastComma !== -1) {
    const cityPart = raw.slice(0, lastComma).trim();
    const countryPart = raw.slice(lastComma + 1).trim();
    location = {
      city: cityPart === "" ? null : cityPart,
      region: null,
      country: normalizeCountry(countryPart),
    };
  } else {
    const country = normalizeCountry(raw);
    location =
      country !== null
        ? { city: null, region: null, country }
        : { city: raw, region: null, country: null };
  }

  const populated = location.city !== null || location.country !== null;
  const provenance = populated
    ? { field: "location", source: rawFact.source, method: "direct" as const }
    : null;

  return { location, provenance };
}

/**
 * @param asOf YYYY-MM month that ongoing jobs run to when computing
 *   years_experience. Passed in, never read from the clock, so the same facts
 *   always resolve to the same record.
 */
export function resolveCandidateGroup(
  group: CandidateFactGroup,
  asOf?: string,
): CanonicalCandidate {
  const { facts, matchKey, candidateId } = group;

  const fullName = resolveScalarField(facts, "full_name", matchKey);
  const headline = resolveScalarField(facts, "headline", matchKey);
  const githubLink = resolveScalarField(facts, "links.github", matchKey);
  const portfolioLink = resolveScalarField(facts, "links.portfolio", matchKey);
  const linkedinLink = resolveScalarField(facts, "links.linkedin", matchKey);
  const emails = resolveArrayField(facts, "emails", matchKey);
  const phones = resolveArrayField(facts, "phones", matchKey);
  const skills = resolveArrayField(facts, "skills", matchKey);
  const experience = resolveExperience(facts, matchKey);
  const education = resolveEducation(facts, matchKey);
  const yearsExperience = resolveYearsExperience(facts, asOf);
  const { location, provenance: locationProvenance } = resolveLocation(facts);

  const provenance = [
    fullName.provenance,
    headline.provenance,
    githubLink.provenance,
    portfolioLink.provenance,
    linkedinLink.provenance,
    emails.provenance,
    phones.provenance,
    skills.provenance,
    ...experience.provenance,
    ...education.provenance,
    yearsExperience.provenance,
    locationProvenance,
  ].filter((entry): entry is ProvenanceEntry => entry !== null);

  const overall_confidence = averageConfidence([
    fullName.confidence,
    headline.confidence,
    githubLink.confidence,
    portfolioLink.confidence,
    linkedinLink.confidence,
    emails.confidence,
    phones.confidence,
    skills.confidence,
    experience.confidence,
    education.confidence,
    yearsExperience.confidence,
  ]);

  return {
    candidate_id: candidateId,
    // Reachable when no full_name fact exists (e.g. GitHub sparse_profile-only group).
    // Ineligible-but-present full_name is dead code today — all scalar fields are passthrough.
    full_name: fullName.value ?? "",
    emails: emails.values,
    phones: phones.values,
    location,
    links: {
      linkedin: linkedinLink.value,
      github: githubLink.value,
      portfolio: portfolioLink.value,
      other: [],
    },
    headline: headline.value,
    years_experience: yearsExperience.value,
    skills: resolveSkillEntries(facts, skills.values),
    experience: experience.entries,
    education: education.entries,
    provenance,
    overall_confidence,
  };
}
