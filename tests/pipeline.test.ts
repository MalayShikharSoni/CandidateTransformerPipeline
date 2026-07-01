import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCsvFacts } from "../src/adapters/csv.js";
import { readGitHubFacts } from "../src/adapters/github.js";
import { groupFactsByCandidate } from "../src/merge/group.js";
import { resolveCandidateGroup } from "../src/merge/resolve.js";
import type { NormalizedFact } from "../src/schemas/raw-fact.js";
import { normalizeFacts } from "../src/normalizers/index.js";
import { projectCandidate } from "../src/projection/project.js";
import type { CandidateFactGroup } from "../src/merge/group.js";

const fixtures = JSON.parse(
  readFileSync("fixtures/github-responses.json", "utf8"),
);

describe("pipeline edge cases", () => {
  it("missing source entirely: CSV-only run produces valid canonical without throwing", async () => {
    const { facts: csvFacts } = await readCsvFacts("fixtures/recruiter.csv");
    const malayCsv = csvFacts.filter((fact) => fact.rowIndex === 0);
    const normalized = normalizeFacts(malayCsv);
    const [group] = groupFactsByCandidate(normalized);
    const canonical = resolveCandidateGroup(group);

    expect(canonical.candidate_id).toBeTruthy();
    expect(canonical.full_name).toBe("Malay Shikhar Soni");
    expect(canonical.emails).toContain("malayshikhar2004@gmail.com");
    expect(canonical.phones).toContain("+919876543210");
  });

  it("conflicting non-null values: CSV full_name wins and conflict is flagged", () => {
    const facts: NormalizedFact[] = [
      {
        field: "full_name",
        rawValue: "Malay Shikhar Soni",
        source: "csv",
        sourceMethod: "csv_column:name",
        rowIndex: 0,
        normalizedValue: "Malay Shikhar Soni",
        normalizationSucceeded: true,
      },
      {
        field: "full_name",
        rawValue: "Malay S.",
        source: "github",
        sourceMethod: "github_field:name",
        rowIndex: 0,
        normalizedValue: "Malay S.",
        normalizationSucceeded: true,
      },
      {
        field: "emails",
        rawValue: "malayshikhar2004@gmail.com",
        source: "csv",
        sourceMethod: "csv_column:email",
        rowIndex: 0,
        normalizedValue: "malayshikhar2004@gmail.com",
        normalizationSucceeded: true,
      },
    ];
    const group: CandidateFactGroup = {
      candidateId: "test",
      matchKey: "email:malayshikhar2004@gmail.com",
      facts,
    };
    const canonical = resolveCandidateGroup(group);

    expect(canonical.full_name).toBe("Malay Shikhar Soni");
    expect(canonical.provenance).toContainEqual({
      field: "full_name",
      source: "csv",
      method: "precedence_override_conflict",
    });
  });

  it("malformed structured data: bad phone excluded with normalization_failed provenance", async () => {
    const { facts: csvFacts } = await readCsvFacts("fixtures/recruiter.csv");
    const rohan = resolveCandidateGroup(
      groupFactsByCandidate(normalizeFacts(csvFacts)).find((group) =>
        group.matchKey.includes("rohan"),
      )!,
    );

    expect(rohan.phones).toEqual([]);
    expect(rohan.provenance).toContainEqual({
      field: "phones",
      source: "csv",
      method: "normalization_failed",
    });
  });

  it("sparse unstructured source: GitHub links.github merges with CSV fields", async () => {
    const { facts: csvFacts } = await readCsvFacts("fixtures/recruiter.csv");
    const malayCsv = csvFacts.filter((fact) => fact.rowIndex === 0);
    const mockFetch = async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof Request ? url.url : url.href;
      if (href.includes("/repos")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify(fixtures.sparse_profile), { status: 200 });
    };
    const { facts: githubFacts } = await readGitHubFacts("rohanmehta", {
      fetch: mockFetch,
    });
    const malay = resolveCandidateGroup(
      groupFactsByCandidate(normalizeFacts([...malayCsv, ...githubFacts])).find(
        (group) => group.matchKey.includes("malayshikhar"),
      )!,
    );

    expect(malay.links.github).toBe("https://github.com/rohanmehta");
    expect(malay.full_name).toBe("Malay Shikhar Soni");
    expect(malay.emails).toContain("malayshikhar2004@gmail.com");
  });

  it('custom config on_missing error: missing required headline returns { error }', async () => {
    const { facts: csvFacts } = await readCsvFacts("fixtures/recruiter.csv");
    const aditi = resolveCandidateGroup(
      groupFactsByCandidate(normalizeFacts(csvFacts)).find((group) =>
        group.matchKey.includes("aditi"),
      )!,
    );
    const result = projectCandidate(aditi, {
      fields: [
        {
          path: "headline",
          from: "headline",
          type: "string",
          required: true,
          normalize: "none",
        },
      ],
      include_confidence: false,
      on_missing: "error",
    });

    expect(result).toHaveProperty("error");
    expect(String((result as { error: string }).error)).toContain("headline");
  });
});
