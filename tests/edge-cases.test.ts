import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCsvFacts } from "../src/adapters/csv.js";
import { readGitHubFacts, type FetchFn } from "../src/adapters/github.js";
import { createLogger } from "../src/log.js";
import { groupFactsByCandidate } from "../src/merge/group.js";
import { resolveCandidateGroup } from "../src/merge/resolve.js";
import { normalizeFacts } from "../src/normalizers/index.js";
import { runPipeline, type PipelineStats } from "../src/pipeline.js";
import { projectCandidate } from "../src/projection/project.js";
import { DEFAULT_CONFIG, type ProjectionConfig } from "../src/schemas/config.js";
import type { RawFact } from "../src/schemas/raw-fact.js";
import { githubFixtures, requestUrl } from "./helpers.js";

function writeCsv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cdt-edge-"));
  const path = join(dir, "input.csv");
  writeFileSync(path, contents);
  return path;
}

const HEADER = "name,email,phone,current_company,title,github_username";

function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function csvFact(field: string, rawValue: string, rowIndex: number): RawFact {
  return { field, rawValue, source: "csv", sourceMethod: "test", rowIndex };
}

describe("runPipeline", () => {
  it("fetches a username once even when several rows share it via --github", async () => {
    const csvPath = writeCsv(
      `${HEADER}\nA,a@example.com,9876543210,Acme,Dev,\nB,b@example.com,9876543211,Acme,Dev,\n`,
    );
    const fetch = vi.fn<FetchFn>(async (url) =>
      respond(requestUrl(url).includes("/repos") ? [] : { bio: "Shared bio" }),
    );

    const result = await runPipeline({ csvPath, config: DEFAULT_CONFIG, githubUser: "shared", fetch });

    expect(fetch).toHaveBeenCalledTimes(2); // one profile + one repos call, not four
    expect(result.ok && result.stats.githubUsernames).toBe(1);
  });

  it("returns a setup error for an unusable CSV", async () => {
    const result = await runPipeline({ csvPath: "fixtures/missing.csv", config: DEFAULT_CONFIG });
    expect(result).toMatchObject({ ok: false });
  });

  it("counts per-candidate errors and sorts warnings by username", async () => {
    const csvPath = writeCsv(
      `${HEADER}\nA,a@example.com,9876543210,Acme,Dev,zed\nB,b@example.com,9876543211,Acme,Dev,amy\n`,
    );
    const fetch: FetchFn = async () => respond({ message: "Not Found" }, 404);
    const config: ProjectionConfig = {
      fields: [{ path: "headline", from: "headline", type: "string", required: true, normalize: "none" }],
      include_confidence: false,
      on_missing: "error",
    };

    const result = await runPipeline({ csvPath, config, fetch });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stats.candidateErrors).toBe(2);
      expect(result.warnings.map((w) => w.username)).toEqual(["amy", "zed"]);
    }
  });
});

describe("github adapter edge cases", () => {
  it("reports a network error instead of throwing", async () => {
    const fetch: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await readGitHubFacts("someone", { fetch });
    expect(result.warnings[0].message).toContain("ECONNRESET");
  });

  it("reports a body that isn't JSON", async () => {
    const result = await readGitHubFacts("someone", { fetch: async () => respond("<html>oops</html>") });
    expect(result.warnings[0].message).toContain("not valid JSON");
  });

  it("reports a profile that isn't an object, or repos that aren't a list", async () => {
    const notObject = await readGitHubFacts("someone", { fetch: async () => respond(42) });
    expect(notObject.warnings[0].message).toContain("not an object");

    const notList = await readGitHubFacts("someone", {
      fetch: async (url) => respond(requestUrl(url).includes("/repos") ? { repos: [] } : githubFixtures.full_profile),
    });
    expect(notList.facts.length).toBeGreaterThan(0);
    expect(notList.warnings[0].message).toContain("not a list");
  });

  it("does not wait out a long rate-limit reset, and says when it resets", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const sleep = vi.fn(async () => {});
    const fetch: FetchFn = async () =>
      respond({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      });

    const result = await readGitHubFacts("someone", { fetch, sleep });

    expect(sleep).not.toHaveBeenCalled();
    expect(result.warnings[0].message).toContain("rate limit");
    expect(result.warnings[0].message).toContain(new Date(reset * 1000).toISOString());
  });

  it("distinguishes a plain 403 and other HTTP errors", async () => {
    const forbidden = await readGitHubFacts("someone", { fetch: async () => respond({}, 403) });
    expect(forbidden.warnings[0].message).toContain("refused");

    const serverError = await readGitHubFacts("someone", { fetch: async () => respond({}, 502) });
    expect(serverError.warnings[0].message).toContain("HTTP 502");
  });

  it("URL-encodes the username and ignores a blank one", async () => {
    const fetch = vi.fn<FetchFn>(async () => respond({}, 404));
    await readGitHubFacts("a/b?c", { fetch });
    expect(requestUrl(fetch.mock.calls[0][0])).toBe("https://api.github.com/users/a%2Fb%3Fc");

    const blank = await readGitHubFacts("   ", { fetch });
    expect(blank).toEqual({ facts: [], warnings: [], cacheHits: 0 });
  });
});

describe("csv adapter edge cases", () => {
  it("reports a CSV that can't be parsed", async () => {
    const path = writeCsv(`${HEADER}\n"unterminated,a@example.com,1,Acme,Dev,\n`);
    const result = await readCsvFacts(path);
    expect(result.error).toContain("cannot parse");
  });

  it("returns no facts and no error for a header-only file", async () => {
    const result = await readCsvFacts(writeCsv(`${HEADER}\n`));
    expect(result).toEqual({ facts: [], rowCount: 0 });
  });
});

describe("grouping edge cases", () => {
  it("merges two CSV rows with the same email into one candidate", () => {
    const groups = groupFactsByCandidate(
      normalizeFacts([
        csvFact("full_name", "Aditi Rao", 0),
        csvFact("emails", "aditi@example.com", 0),
        csvFact("full_name", "Aditi Rao", 1),
        csvFact("emails", "ADITI@example.com ", 1),
        csvFact("phones", "9876543299", 1),
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(resolveCandidateGroup(groups[0]).phones).toEqual(["+919876543299"]);
  });

  it("falls back to name+company without an email and marks it in provenance", () => {
    const [group] = groupFactsByCandidate(
      normalizeFacts([csvFact("full_name", "Rohan Mehta", 0), csvFact("experience.company", "Globex", 0)]),
    );

    expect(group.matchKey).toBe("name+company:rohan mehta|globex");
    expect(resolveCandidateGroup(group).provenance).toContainEqual({
      field: "full_name",
      source: "csv",
      method: "fallback_match",
    });
  });

  it("keeps a row with neither email nor company as its own candidate", () => {
    const groups = groupFactsByCandidate(
      normalizeFacts([csvFact("full_name", "Solo", 0), csvFact("full_name", "Other", 1)]),
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.matchKey.startsWith("standalone:"))).toBe(true);
  });
});

describe("projection type coercion", () => {
  const [group] = groupFactsByCandidate(
    normalizeFacts([csvFact("full_name", "Aditi Rao", 0), csvFact("emails", "aditi@example.com", 0)]),
  );
  const candidate = resolveCandidateGroup(group);
  const project = (type: ProjectionConfig["fields"][number]["type"], from: string) =>
    projectCandidate(candidate, {
      fields: [{ path: "value", from, type, required: false, normalize: "none" }],
      include_confidence: false,
      on_missing: "null",
    });

  it("turns a number into a string, and rejects objects as strings", () => {
    expect(project("string", "overall_confidence")).toEqual({ value: String(candidate.overall_confidence) });
    expect(project("string", "location")).toEqual({ value: null });
  });

  it("checks array element types", () => {
    expect(project("string[]", "emails")).toEqual({ value: ["aditi@example.com"] });
    expect(project("number[]", "emails")).toEqual({ value: null });
    expect(project("object[]", "emails")).toEqual({ value: null });
    expect(project("string[]", "full_name")).toEqual({ value: null });
  });

  it("only accepts real booleans", () => {
    expect(project("boolean", "full_name")).toEqual({ value: null });
  });
});

describe("logger edge cases", () => {
  const csvOnly: PipelineStats = {
    csvRows: 1,
    githubUsernames: 0,
    githubUsernamesWithWarnings: 0,
    githubCacheHits: 0,
    githubRateLimitRemaining: null,
    candidates: 1,
    candidateErrors: 0,
  };

  it("leaves GitHub out of the summary for a CSV-only run", () => {
    const lines: string[] = [];
    createLogger("text", (line) => lines.push(line)).summary(csvOnly, 5);
    expect(lines[0]).toBe("summary: 1 CSV row -> 1 candidate (0 errors) | 5 ms");
  });

  it("prefixes notes and errors in text, and tags them in json", () => {
    const text: string[] = [];
    const textLog = createLogger("text", (line) => text.push(line));
    textLog.note("hello");
    textLog.error("boom");
    expect(text).toEqual(["note: hello", "Error: boom"]);

    const json: string[] = [];
    const jsonLog = createLogger("json", (line) => json.push(line));
    jsonLog.note("hello");
    jsonLog.error("boom");
    expect(json.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "info", event: "note", message: "hello" },
      { level: "error", event: "error", message: "boom" },
    ]);
  });
});
