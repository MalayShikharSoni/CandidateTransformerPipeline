import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineOptions } from "../src/pipeline.js";
import { DEFAULT_CONFIG, ProjectionConfig } from "../src/schemas/config.js";
import { githubFixtures, requestUrl } from "./helpers.js";

/**
 * Golden-file tests: run the whole pipeline on the sample inputs (GitHub
 * mocked from fixtures) and compare against output files kept in git.
 * Any change to the output shows up as a diff in review.
 * After an intended change, regenerate with: npx vitest run -u
 */

const customConfig = ProjectionConfig.parse(
  JSON.parse(readFileSync("fixtures/custom-config.json", "utf8")),
);

const mockGitHub: PipelineOptions["fetch"] = async (url) => {
  const body = requestUrl(url).includes("/repos")
    ? githubFixtures.full_profile_repos
    : githubFixtures.full_profile;
  return new Response(JSON.stringify(body), { status: 200 });
};

async function runOnSample(config: ProjectionConfig) {
  const result = await runPipeline({
    csvPath: "fixtures/recruiter.csv",
    config,
    fetch: mockGitHub,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

describe("golden output on fixtures/recruiter.csv", () => {
  it("default config", async () => {
    const { records } = await runOnSample(DEFAULT_CONFIG);
    await expect(`${JSON.stringify(records, null, 2)}\n`).toMatchFileSnapshot(
      "./golden/default-output.json",
    );
  });

  it("custom config", async () => {
    const { records } = await runOnSample(customConfig);
    await expect(`${JSON.stringify(records, null, 2)}\n`).toMatchFileSnapshot(
      "./golden/custom-output.json",
    );
  });

  it("is deterministic: two runs produce identical output", async () => {
    const first = await runOnSample(DEFAULT_CONFIG);
    const second = await runOnSample(DEFAULT_CONFIG);
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });

  it("reports run stats", async () => {
    const { stats, warnings } = await runOnSample(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
    expect(stats).toEqual({
      csvRows: 4,
      githubUsernames: 1,
      githubUsernamesWithWarnings: 0,
      githubCacheHits: 0,
      githubRateLimitRemaining: null,
      candidates: 4,
      candidateErrors: 0,
    });
  });
});
