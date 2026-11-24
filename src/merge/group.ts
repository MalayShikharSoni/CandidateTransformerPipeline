import { createHash } from "node:crypto";
import type { NormalizedFact } from "../schemas/raw-fact.js";

export interface CandidateFactGroup {
  /** sha256(matchKey) — deterministic for a given matchKey string */
  candidateId: string;
  /** e.g. "email:foo@bar.com", "name+company:...", or "standalone:..." */
  matchKey: string;
  facts: NormalizedFact[];
}

function bundleKey(fact: NormalizedFact): string {
  return `${fact.source}:${fact.rowIndex}`;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getStringValue(facts: NormalizedFact[], field: string): string | undefined {
  for (const fact of facts) {
    if (fact.field !== field) {
      continue;
    }

    if (
      fact.normalizationSucceeded &&
      typeof fact.normalizedValue === "string"
    ) {
      const trimmed = fact.normalizedValue.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }

    if (typeof fact.rawValue === "string") {
      const trimmed = fact.rawValue.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }

  return undefined;
}

function normalizedName(facts: NormalizedFact[]): string | undefined {
  const name = getStringValue(facts, "full_name");
  return name === undefined ? undefined : normalizeKeyPart(name);
}

export function computeMatchKey(facts: NormalizedFact[]): string | null {
  const emails = facts
    .filter((fact) => fact.field === "emails")
    .map((fact) => {
      if (
        fact.normalizationSucceeded &&
        typeof fact.normalizedValue === "string"
      ) {
        return normalizeKeyPart(fact.normalizedValue);
      }
      if (typeof fact.rawValue === "string") {
        return normalizeKeyPart(fact.rawValue);
      }
      return null;
    })
    .filter((email): email is string => email !== null && email !== "");

  const distinctEmails = new Set(emails);
  if (distinctEmails.size > 1) {
    return null;
  }
  if (distinctEmails.size === 1) {
    return `email:${[...distinctEmails][0]}`;
  }

  const name = getStringValue(facts, "full_name");
  const company = getStringValue(facts, "experience.company");
  if (name !== undefined && company !== undefined) {
    return `name+company:${normalizeKeyPart(name)}|${normalizeKeyPart(company)}`;
  }

  return null;
}

function provisionalBundles(facts: NormalizedFact[]): NormalizedFact[][] {
  const byKey = new Map<string, NormalizedFact[]>();

  for (const fact of facts) {
    const key = bundleKey(fact);
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  return [...byKey.values()];
}

function isRowLinked(partnerFacts: NormalizedFact[]): boolean {
  return partnerFacts.some((fact) => fact.rowLinked === true);
}

function canUnionCrossSource(
  csvFacts: NormalizedFact[],
  partnerFacts: NormalizedFact[],
): boolean {
  // The CSV row named this source itself (github_username or resume_path), so
  // the recruiter has already said they are the same person. A different display name ("Malay S.") or a
  // second email is a conflict to record in provenance, not a reason to split
  // one person into two records.
  if (isRowLinked(partnerFacts)) {
    return true;
  }

  // Not linked by the row (e.g. one --github username applied to every row):
  // only merge when nothing contradicts the CSV row.
  const csvKey = computeMatchKey(csvFacts);
  if (csvKey === null) {
    return false;
  }

  const unionFacts = [...csvFacts, ...partnerFacts];
  if (computeMatchKey(unionFacts) !== csvKey) {
    return false;
  }

  const csvName = normalizedName(csvFacts);
  const partnerName = normalizedName(partnerFacts);
  if (
    csvName !== undefined &&
    partnerName !== undefined &&
    csvName !== partnerName
  ) {
    return false;
  }

  return true;
}

function unionCrossSource(bundles: NormalizedFact[][]): NormalizedFact[][] {
  const csvBundles = bundles.filter((bundle) => bundle[0]?.source === "csv");

  // GitHub and resume facts carry the rowIndex of the CSV row they were read
  // for, so each CSV row has at most one partner bundle per source: look them up
  // instead of comparing every CSV row with every bundle (O(n) instead of O(n²)).
  const partnersByRow = new Map<number, NormalizedFact[][]>();
  for (const bundle of bundles) {
    if (bundle.length === 0 || bundle[0].source === "csv") {
      continue;
    }
    const partners = partnersByRow.get(bundle[0].rowIndex);
    if (partners === undefined) {
      partnersByRow.set(bundle[0].rowIndex, [bundle]);
    } else {
      partners.push(bundle);
    }
  }

  const result: NormalizedFact[][] = [];

  for (const csvBundle of csvBundles) {
    const rowIndex = csvBundle[0].rowIndex;
    const partners = partnersByRow.get(rowIndex) ?? [];
    const joined = partners.filter((partner) => canUnionCrossSource(csvBundle, partner));
    const leftover = partners.filter((partner) => !joined.includes(partner));

    result.push([...csvBundle, ...joined.flat()]);
    if (leftover.length > 0) {
      partnersByRow.set(rowIndex, leftover);
    } else {
      partnersByRow.delete(rowIndex);
    }
  }

  // Data that joined no CSV row is still emitted, one record per bundle.
  for (const partners of partnersByRow.values()) {
    result.push(...partners);
  }

  return result;
}

function standaloneMatchKey(facts: NormalizedFact[]): string {
  const fingerprint = facts
    .map((fact) =>
      JSON.stringify({
        field: fact.field,
        source: fact.source,
        sourceMethod: fact.sourceMethod,
        rawValue: fact.rawValue,
      }),
    )
    .sort()
    .join("|");

  const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex");
  return `standalone:${fingerprintHash}`;
}

function candidateIdFromMatchKey(matchKey: string): string {
  return createHash("sha256").update(matchKey).digest("hex");
}

// The match key (and so candidate_id) comes from the CSV facts when there are
// any. A merged-in GitHub or resume email therefore can't change the id or make the key
// ambiguous, and the same CSV row always gets the same id.
function resolveMatchKey(facts: NormalizedFact[]): string {
  const csvFacts = facts.filter((fact) => fact.source === "csv");
  const anchor = csvFacts.length > 0 ? csvFacts : facts;
  return computeMatchKey(anchor) ?? standaloneMatchKey(anchor);
}

export function groupFactsByCandidate(
  facts: NormalizedFact[],
): CandidateFactGroup[] {
  const mergedBundles = unionCrossSource(provisionalBundles(facts));
  const groupsByMatchKey = new Map<string, NormalizedFact[]>();

  for (const bundle of mergedBundles) {
    const matchKey = resolveMatchKey(bundle);
    const existing = groupsByMatchKey.get(matchKey);
    if (existing === undefined) {
      groupsByMatchKey.set(matchKey, [...bundle]);
    } else {
      existing.push(...bundle);
    }
  }

  return [...groupsByMatchKey.entries()].map(([matchKey, groupFacts]) => ({
    candidateId: candidateIdFromMatchKey(matchKey),
    matchKey,
    facts: groupFacts,
  }));
}
