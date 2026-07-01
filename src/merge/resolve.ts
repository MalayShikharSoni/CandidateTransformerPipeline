import type {
  CanonicalCandidate,
  ExperienceEntry,
  ProvenanceEntry,
  ProvenanceMethod,
} from "../schemas/canonical.js";
import { normalizeCountry } from "../normalizers/country.js";
import type { NormalizedFact } from "../schemas/raw-fact.js";
import type { CandidateFactGroup } from "./group.js";

const SOURCE_PRECEDENCE = ["csv", "github"] as const;
type Source = (typeof SOURCE_PRECEDENCE)[number];

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

function sourceBaseScore(source: Source): number {
  return source === "csv" ? 0.9 : 0.6;
}

function factScore(fact: NormalizedFact, source: Source): number {
  return sourceBaseScore(source) * (fact.normalizationSucceeded ? 1 : 0.5);
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
  return winner.valueMethod;
}

function sourcesAgreeOnValue(
  candidates: Partial<Record<Source, ScalarCandidate>>,
): boolean {
  const csv = candidates.csv;
  const github = candidates.github;
  return (
    csv?.eligible === true &&
    github?.eligible === true &&
    csv.value !== null &&
    github.value !== null &&
    valuesEqual(csv.value, github.value)
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

  const csv = candidates.csv;
  const github = candidates.github;
  const conflict =
    csv?.eligible === true &&
    github?.eligible === true &&
    csv.value !== null &&
    github.value !== null &&
    !valuesEqual(csv.value, github.value);

  if (winner === null) {
    return { value: null, provenance: null, confidence: null };
  }

  const confidence = Math.min(
    1,
    factScore(winner.fact, winner.source) +
      (sourcesAgreeOnValue(candidates) ? 0.1 : 0),
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
): ProvenanceMethod {
  if (matchKey.startsWith("name+company:")) {
    return "fallback_match";
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
      Math.max(scoresBySource.get(fact.source) ?? 0, factScore(fact, fact.source)),
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

  const csvValues = valuesBySource.get("csv") ?? new Set();
  const githubValues = valuesBySource.get("github") ?? new Set();
  const sharedValue = [...csvValues].some((value) =>
    [...githubValues].some((other) => valuesEqual(value, other)),
  );

  return Math.min(1, maxScore + (sharedValue ? 0.1 : 0));
}

function experienceFieldConfidence(facts: NormalizedFact[]): number | null {
  const experienceFacts = facts.filter(
    (fact) =>
      fact.field === "experience.company" || fact.field === "experience.title",
  );

  let hasEligibleValue = false;
  const scoresBySource = new Map<Source, number>();

  for (const fact of experienceFacts) {
    const candidate = toScalarCandidate(fact);
    scoresBySource.set(
      fact.source,
      Math.max(scoresBySource.get(fact.source) ?? 0, factScore(fact, fact.source)),
    );
    if (candidate.eligible) {
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

  const source: Source = contributors.has("csv") ? "csv" : "github";

  return {
    values,
    provenance: {
      field,
      source,
      method: arrayProvenanceMethod(usedNormalization, matchKey),
    },
    confidence: arrayFieldConfidence(facts, field),
  };
}

function bundleKey(fact: NormalizedFact): string {
  return `${fact.source}:${fact.rowIndex}`;
}

// experience[] aggregates one entry per source bundle — multiple sources add
// entries, they don't compete. Unreachable with CSV+GitHub today (only CSV emits
// experience facts), but kept correct for a future second experience source.
function experienceProvenanceMethod(
  matchKey: string,
  usedNormalization: boolean,
): ProvenanceMethod {
  if (matchKey.startsWith("name+company:")) {
    return "fallback_match";
  }
  return usedNormalization ? "normalized" : "direct";
}

export function resolveExperience(
  facts: NormalizedFact[],
  matchKey: string,
): {
  entries: ExperienceEntry[];
  provenance: ProvenanceEntry | null;
  confidence: number | null;
} {
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
  const contributors = new Set<Source>();

  for (const bundleFacts of byBundle.values()) {
    const company = resolveScalarField(bundleFacts, "experience.company", matchKey);
    const title = resolveScalarField(bundleFacts, "experience.title", matchKey);

    const companyValue = company.value ?? "";
    const titleValue = title.value ?? "";

    if (companyValue === "" && titleValue === "") {
      continue;
    }

    const source = bundleFacts[0]?.source;
    if (source !== undefined) {
      contributors.add(source);
    }

    entries.push({
      company: companyValue,
      title: titleValue,
      start: null,
      end: null,
      summary: null,
    });
  }

  if (entries.length === 0) {
    return { entries: [], provenance: null, confidence: null };
  }

  const source: Source = contributors.has("csv") ? "csv" : "github";

  return {
    entries,
    provenance: {
      field: "experience",
      source,
      method: experienceProvenanceMethod(matchKey, false),
    },
    confidence: experienceFieldConfidence(facts),
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
  if (rawFact === undefined) {
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

export function resolveCandidateGroup(
  group: CandidateFactGroup,
): CanonicalCandidate {
  const { facts, matchKey, candidateId } = group;

  const fullName = resolveScalarField(facts, "full_name", matchKey);
  const headline = resolveScalarField(facts, "headline", matchKey);
  const githubLink = resolveScalarField(facts, "links.github", matchKey);
  const portfolioLink = resolveScalarField(facts, "links.portfolio", matchKey);
  const emails = resolveArrayField(facts, "emails", matchKey);
  const phones = resolveArrayField(facts, "phones", matchKey);
  const skills = resolveArrayField(facts, "skills", matchKey);
  const experience = resolveExperience(facts, matchKey);
  const { location, provenance: locationProvenance } = resolveLocation(facts);

  const provenance = [
    fullName.provenance,
    headline.provenance,
    githubLink.provenance,
    portfolioLink.provenance,
    emails.provenance,
    phones.provenance,
    skills.provenance,
    experience.provenance,
    locationProvenance,
  ].filter((entry): entry is ProvenanceEntry => entry !== null);

  const overall_confidence = averageConfidence([
    fullName.confidence,
    headline.confidence,
    githubLink.confidence,
    portfolioLink.confidence,
    emails.confidence,
    phones.confidence,
    skills.confidence,
    experience.confidence,
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
      linkedin: null,
      github: githubLink.value,
      portfolio: portfolioLink.value,
      other: [],
    },
    headline: headline.value,
    years_experience: null,
    skills: skills.values.map((name) => ({
      name,
      confidence: skills.confidence ?? 0,
      sources: [skills.provenance?.source ?? "csv"],
    })),
    experience: experience.entries,
    education: [],
    provenance,
    overall_confidence,
  };
}
