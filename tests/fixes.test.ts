import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCsvFacts } from "../src/adapters/csv.js";
import { RateLimitState, readGitHubFacts } from "../src/adapters/github.js";
import { groupFactsByCandidate } from "../src/merge/group.js";
import { resolveCandidateGroup, resolveSkillEntries } from "../src/merge/resolve.js";
import { normalizeFacts } from "../src/normalizers/index.js";
import { projectCandidate } from "../src/projection/project.js";
import { DEFAULT_CONFIG } from "../src/schemas/config.js";
import type { RawFact } from "../src/schemas/raw-fact.js";
import { validateProjectedOutput } from "../src/validate/validate-output.js";

const fixtures = JSON.parse(readFileSync("fixtures/github-responses.json", "utf8"));

function fact(
  field: string,
  rawValue: string,
  source: "csv" | "github",
  extra: Partial<RawFact> = {},
): RawFact {
  return { field, rawValue, source, sourceMethod: "test", rowIndex: 0, ...extra };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Fake fetch: answers profile and repo URLs from the given handlers. */
function fakeFetch(handlers: { profile: () => Response; repos?: () => Response }) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("/repos")) {
      return handlers.repos?.() ?? jsonResponse([]);
    }
    return handlers.profile();
  });
}

const noSleep = vi.fn(async () => {});

describe("merge: CSV row linked to a GitHub username", () => {
  const csvRow = [
    fact("full_name", "Malay Shikhar Soni", "csv"),
    fact("emails", "malayshikhar2004@gmail.com", "csv"),
    fact("experience.company", "Techvanto Academy", "csv"),
  ];
  const githubFacts = [
    fact("full_name", "Malay S.", "github"),
    fact("emails", "malay@work.example", "github"),
    fact("headline", "Backend dev", "github"),
  ];

  it("merges into one record and flags the name conflict when the row named the username", () => {
    const linked = githubFacts.map((f) => ({ ...f, rowLinked: true }));
    const groups = groupFactsByCandidate(normalizeFacts([...csvRow, ...linked]));

    expect(groups).toHaveLength(1);

    const candidate = resolveCandidateGroup(groups[0]);
    expect(candidate.full_name).toBe("Malay Shikhar Soni");
    expect(candidate.headline).toBe("Backend dev");
    expect(candidate.emails).toEqual(["malayshikhar2004@gmail.com", "malay@work.example"]);
    expect(candidate.provenance).toContainEqual({
      field: "full_name",
      source: "csv",
      method: "precedence_override_conflict",
    });
  });

  it("keeps the same candidate_id as the CSV row on its own", () => {
    const linked = githubFacts.map((f) => ({ ...f, rowLinked: true }));
    const [merged] = groupFactsByCandidate(normalizeFacts([...csvRow, ...linked]));
    const [csvOnly] = groupFactsByCandidate(normalizeFacts(csvRow));

    expect(merged.candidateId).toBe(csvOnly.candidateId);
  });

  it("does not merge a mismatched name when the link came from --github, not the row", () => {
    const groups = groupFactsByCandidate(normalizeFacts([...csvRow, ...githubFacts]));
    expect(groups).toHaveLength(2);
  });

  it("only pairs a GitHub bundle with the CSV row it was fetched for", () => {
    const secondRow = [
      fact("full_name", "Aditi Rao", "csv", { rowIndex: 1 }),
      fact("emails", "aditi.rao@example.com", "csv", { rowIndex: 1 }),
    ];
    const githubForRow1 = [fact("headline", "Data person", "github", { rowIndex: 1, rowLinked: true })];

    const candidates = groupFactsByCandidate(
      normalizeFacts([...csvRow, ...secondRow, ...githubForRow1]),
    ).map(resolveCandidateGroup);

    expect(candidates.find((c) => c.full_name === "Aditi Rao")?.headline).toBe("Data person");
    expect(candidates.find((c) => c.full_name === "Malay Shikhar Soni")?.headline).toBeNull();
  });
});

describe("skills: per-skill confidence and sources", () => {
  it("scores a skill seen in both sources higher than one seen in only one", () => {
    const facts = normalizeFacts([
      fact("skills", "ts", "csv"),
      fact("skills", "TypeScript", "github"),
      fact("skills", "Python", "github"),
    ]);

    const skills = resolveSkillEntries(facts, ["TypeScript", "Python"]);

    expect(skills).toEqual([
      { name: "TypeScript", confidence: 1, sources: ["csv", "github"] },
      { name: "Python", confidence: 0.6, sources: ["github"] },
    ]);
  });
});

describe("github adapter: failures are reported, not silent", () => {
  it("reports a rejected token", async () => {
    const result = await readGitHubFacts("someone", {
      fetch: fakeFetch({ profile: () => jsonResponse({ message: "Bad credentials" }, 401) }),
    });

    expect(result.facts).toEqual([]);
    expect(result.warnings[0].message).toContain("401");
  });

  it("reports a user that does not exist", async () => {
    const result = await readGitHubFacts("nobody", {
      fetch: fakeFetch({ profile: () => jsonResponse(fixtures.not_found, 404) }),
    });

    expect(result.warnings[0].message).toContain("not found");
  });

  it("waits and retries once when GitHub sends Retry-After", async () => {
    let calls = 0;
    const fetch = fakeFetch({
      profile: () => {
        calls++;
        return calls === 1
          ? jsonResponse({ message: "slow down" }, 429, { "retry-after": "2" })
          : jsonResponse(fixtures.full_profile);
      },
      repos: () => jsonResponse(fixtures.full_profile_repos),
    });
    const sleep = vi.fn(async () => {});

    const result = await readGitHubFacts("malayshikhar", { fetch, sleep });

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(result.warnings).toEqual([]);
    expect(result.facts.some((f) => f.field === "headline")).toBe(true);
  });

  it("skips the call entirely once the hourly budget is used up", async () => {
    const rateLimit = new RateLimitState();
    rateLimit.update(
      new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      }),
    );
    const fetch = fakeFetch({ profile: () => jsonResponse(fixtures.full_profile) });

    const result = await readGitHubFacts("malayshikhar", { fetch, rateLimit, sleep: noSleep });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.warnings[0].message).toContain("Skipped");
  });

  it("keeps profile facts when only the repos call fails", async () => {
    const result = await readGitHubFacts("malayshikhar", {
      fetch: fakeFetch({
        profile: () => jsonResponse(fixtures.full_profile),
        repos: () => jsonResponse({ message: "boom" }, 500),
      }),
    });

    expect(result.facts.some((f) => f.field === "full_name")).toBe(true);
    expect(result.facts.some((f) => f.field === "skills")).toBe(false);
    expect(result.warnings[0].message).toContain("repos");
  });
});

describe("csv adapter: unusable input is an error, not an empty result", () => {
  it("names the missing columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdt-"));
    const path = join(dir, "bad.csv");
    writeFileSync(path, "name,email\nA,a@example.com\n");

    const result = await readCsvFacts(path);

    expect(result.error).toContain("phone");
    expect(result.error).toContain("title");
  });

  it("reports a missing file", async () => {
    const result = await readCsvFacts("fixtures/does-not-exist.csv");
    expect(result.error).toContain("cannot read");
  });
});

describe("default output schema", () => {
  it("includes links, experience and full skill objects, and passes validation", async () => {
    const { facts } = await readCsvFacts("fixtures/recruiter.csv");
    const [first] = groupFactsByCandidate(normalizeFacts(facts)).map(resolveCandidateGroup);

    const projected = projectCandidate(first, DEFAULT_CONFIG);
    expect(projected).not.toHaveProperty("error");

    const validated = validateProjectedOutput(projected as Record<string, unknown>, DEFAULT_CONFIG);
    expect(validated.ok).toBe(true);
    expect(projected).toHaveProperty("links");
    expect(projected).toHaveProperty("experience");
  });

  it("rejects an object field whose keys don't match the canonical schema", () => {
    const result = validateProjectedOutput(
      { links: { github: 42 } },
      {
        fields: [{ path: "links", from: "links", type: "object", required: false, normalize: "none" }],
        include_confidence: false,
        on_missing: "null",
      },
    );

    expect(result.ok).toBe(false);
  });
});
