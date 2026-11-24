import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryLlmCache } from "../src/adapters/llm-cache.js";
import { readResumeText } from "../src/adapters/resume.js";
import { ResumeExtraction, type ResumeExtractor } from "../src/adapters/resume-llm.js";
import { resolveYearsExperience } from "../src/merge/resolve.js";
import { normalizeEducationEntry, normalizeExperienceEntry } from "../src/normalizers/entries.js";
import { normalizeFacts } from "../src/normalizers/index.js";
import { runPipeline, type PipelineOptions } from "../src/pipeline.js";
import { DEFAULT_CONFIG } from "../src/schemas/config.js";
import type { RawFact } from "../src/schemas/raw-fact.js";

const CSV = "fixtures/recruiter-with-resumes.csv";
const AS_OF = "2026-11";

/**
 * Plays back fixtures/resume-llm-responses.json (hand-written stand-ins until
 * real answers are recorded), matched by resume text, so no test calls the API.
 */
async function replayExtractor() {
  const saved = JSON.parse(readFileSync("fixtures/resume-llm-responses.json", "utf8")) as {
    responses: Record<string, { output: unknown }>;
  };
  const byText = new Map<string, ResumeExtraction>();
  for (const [file, entry] of Object.entries(saved.responses)) {
    const read = await readResumeText(`fixtures/resumes/${file}`);
    if ("text" in read) {
      byText.set(read.text, ResumeExtraction.parse(entry.output));
    }
  }
  const calls: string[] = [];
  const extractor: ResumeExtractor = {
    model: "replay",
    async extract(text) {
      calls.push(text);
      const output = byText.get(text);
      return output === undefined
        ? { ok: false, reason: "no saved answer" }
        : { ok: true, model: "replay", output };
    },
  };
  return { extractor, calls };
}

type Candidate = Record<string, unknown> & {
  full_name: string;
  experience: unknown[];
  provenance: unknown[];
};

function byName(records: unknown[], name: string): Candidate {
  const found = records.find((record) => (record as Candidate).full_name === name);
  if (found === undefined) {
    throw new Error(`no record for ${name}`);
  }
  return found as Candidate;
}

function run(options: Partial<PipelineOptions>) {
  return runPipeline({ csvPath: CSV, config: DEFAULT_CONFIG, asOf: AS_OF, ...options });
}

describe("pipeline with resumes and --llm", () => {
  let extractor: ResumeExtractor;

  beforeAll(async () => {
    ({ extractor } = await replayExtractor());
  });

  it("merges each resume into its CSV row and fills experience, education and years", async () => {
    const result = await run({ extractResume: extractor });
    if (!result.ok) throw new Error(result.error);

    expect(result.records).toHaveLength(5);
    const ananya = byName(result.records, "Ananya Iyer");

    // The CSV job and the resume's matching job are one entry: CSV title, resume dates.
    expect(ananya.experience).toEqual([
      { company: "Northwind Labs", title: "Senior Backend Engineer", start: "2022-01", end: null, summary: null },
      { company: "Contoso Retail", title: "Software Engineer", start: "2018-07", end: "2021-12", summary: null },
    ]);
    // Jul 2018 – Dec 2021 (42 months) + Jan 2022 – Nov 2026 (59 months).
    expect(ananya.years_experience).toBe(8.4);
    expect(ananya.education).toEqual([
      {
        institution: "Indian Institute of Technology Madras",
        degree: "B.Tech",
        field: "Computer Science",
        end_year: 2018,
      },
    ]);
    expect(ananya.headline).toBe("Senior Backend Engineer");
    expect(ananya.links).toEqual({
      linkedin: "https://www.linkedin.com/in/ananya-iyer-dev",
      github: null,
      portfolio: "https://ananya.example.dev",
      other: [],
    });
    // The stand-in answer also invented "Rust" and a Globex job; grounding removed both.
    const skills = (ananya.skills as Array<{ name: string }>).map((skill) => skill.name);
    expect(skills).toEqual(["Go", "Java", "PostgreSQL", "Kafka", "Kubernetes"]);
    expect(JSON.stringify(ananya)).not.toContain("Globex");

    expect(ananya.provenance).toEqual(
      expect.arrayContaining([
        { field: "experience", source: "csv", method: "direct" },
        { field: "experience", source: "resume", method: "llm_extracted" },
        { field: "education", source: "resume", method: "llm_extracted" },
        { field: "years_experience", source: "resume", method: "derived" },
        { field: "headline", source: "resume", method: "llm_extracted" },
        { field: "links.linkedin", source: "resume", method: "direct" },
      ]),
    );
  });

  it("uses a regex phone from the resume when the CSV has none", async () => {
    const result = await run({ extractResume: extractor });
    if (!result.ok) throw new Error(result.error);
    const daniel = byName(result.records, "Daniel Okafor");

    expect(daniel.phones).toEqual(["+919876543102"]);
    expect(daniel.provenance).toContainEqual({ field: "phones", source: "resume", method: "normalized" });
    // The stand-in reworded one title; the job stays, its title is blanked.
    expect(daniel.experience).toContainEqual({
      company: "Tailspin Toys",
      title: "",
      start: "2017-06",
      end: "2020-02",
      summary: null,
    });
  });

  it("matches the CSV job to the first resume job at the same company only", async () => {
    const result = await run({ extractResume: extractor });
    if (!result.ok) throw new Error(result.error);
    const sofia = byName(result.records, "Sofia Marín");

    expect(sofia.experience).toEqual([
      { company: "Woodgrove Bank", title: "Data Analyst", start: "2021-03", end: null, summary: null },
      { company: "Woodgrove Bank", title: "Analyst Intern", start: "2020-06", end: "2020-08", summary: null },
      { company: "Universidad de Granada", title: "Research Assistant", start: "2018-09", end: "2020-05", summary: null },
    ]);
    expect(sofia.education).toHaveLength(2);
  });

  it("warns about a missing resume and still emits that candidate from the CSV", async () => {
    const result = await run({ extractResume: extractor });
    if (!result.ok) throw new Error(result.error);

    expect(result.warnings).toEqual([
      {
        source: "resume",
        subject: "resumes/ravi-kumar.pdf",
        message: expect.stringContaining("cannot read resume") as string,
      },
    ]);
    expect(byName(result.records, "Ravi Kumar").experience).toHaveLength(1);
    expect(result.stats).toMatchObject({
      resumes: 5,
      resumesWithWarnings: 1,
      resumeLlmCalls: 4,
      resumeLlmCacheHits: 0,
      resumeValuesDropped: 3,
    });
  });

  it("replays cached answers on the next run and gives byte-identical output", async () => {
    const llmCache = new MemoryLlmCache();
    const { extractor: counted, calls } = await replayExtractor();

    const first = await run({ extractResume: counted, llmCache });
    const second = await run({ extractResume: counted, llmCache });
    if (!first.ok || !second.ok) throw new Error("run failed");

    expect(calls).toHaveLength(4);
    expect(second.stats).toMatchObject({ resumeLlmCalls: 0, resumeLlmCacheHits: 4 });
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });
});

describe("pipeline with resumes, without --llm", () => {
  it("adds only regex facts: links and phones, no jobs, degrees or years", async () => {
    const result = await run({});
    if (!result.ok) throw new Error(result.error);
    const ananya = byName(result.records, "Ananya Iyer");

    expect(ananya.experience).toHaveLength(1);
    expect(ananya.education).toEqual([]);
    expect(ananya.years_experience).toBeNull();
    expect((ananya.links as { linkedin: string }).linkedin).toBe(
      "https://www.linkedin.com/in/ananya-iyer-dev",
    );
    expect(result.stats.resumeLlmCalls).toBe(0);
  });

  it("keeps going when every LLM call fails", async () => {
    const failing: ResumeExtractor = {
      model: "down",
      async extract() {
        return { ok: false, reason: "Anthropic API error (HTTP 500): overloaded" };
      },
    };
    const result = await run({ extractResume: failing });
    if (!result.ok) throw new Error(result.error);

    expect(result.records).toHaveLength(5);
    expect(result.warnings).toHaveLength(5);
    expect(byName(result.records, "Kenji Watanabe").phones).toEqual(["+919876543104"]);
  });
});

describe("entry normalizers", () => {
  it("normalizes job dates and flags one that can't be parsed", () => {
    expect(
      normalizeExperienceEntry({ company: " Acme ", title: "Dev", start: "Jan 2020", end: "Present" }),
    ).toEqual({
      value: { company: "Acme", title: "Dev", start: "2020-01", end: null, current: true },
      succeeded: true,
    });
    expect(
      normalizeExperienceEntry({ company: "Acme", title: null, start: "Jan '21", end: "Mar '23" }),
    ).toEqual({
      value: { company: "Acme", title: null, start: null, end: null, current: false },
      succeeded: false,
    });
    expect(normalizeExperienceEntry({ company: null, title: "  " })).toEqual({ value: null, succeeded: false });
    expect(normalizeExperienceEntry("not an entry")).toEqual({ value: null, succeeded: false });
  });

  it("checks the graduation year range", () => {
    expect(normalizeEducationEntry({ institution: "Uni", degree: "BA", field: null, end_year: 1850 })).toEqual({
      value: { institution: "Uni", degree: "BA", field: null, end_year: null },
      succeeded: false,
    });
    expect(normalizeEducationEntry({ institution: "", end_year: 2020 })).toEqual({ value: null, succeeded: false });
  });
});

describe("resolveYearsExperience", () => {
  const job = (start: string | null, end: string | null): RawFact => ({
    field: "experience.entry",
    rawValue: { company: "Acme", title: "Dev", start, end },
    source: "resume",
    sourceMethod: "resume_llm:experience",
    rowIndex: 0,
  });

  it("counts overlapping jobs once and includes both end months", () => {
    const facts = normalizeFacts([job("Jan 2020", "Dec 2020"), job("Jun 2020", "Jun 2021")]);
    expect(resolveYearsExperience(facts, AS_OF).value).toBe(1.5);
  });

  it("runs an ongoing job to asOf, and skips it without asOf", () => {
    const facts = normalizeFacts([job("Nov 2025", "Present")]);
    expect(resolveYearsExperience(facts, "2026-10").value).toBe(1);
    expect(resolveYearsExperience(facts, undefined).value).toBeNull();
  });

  it("leaves out jobs with no end date or an end before the start", () => {
    const facts = normalizeFacts([job("2019", null), job("2021", "2018")]);
    expect(resolveYearsExperience(facts, AS_OF)).toEqual({
      value: null,
      provenance: null,
      confidence: null,
    });
  });
});
