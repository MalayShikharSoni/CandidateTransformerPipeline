/**
 * Measures the LLM resume extraction against the hand-written answer keys in
 * fixtures/resumes/labels/ (generated from scripts/resume-fixtures-data.ts).
 *
 *   npm run eval:resumes                # real Claude calls (needs ANTHROPIC_API_KEY), one per resume
 *   npm run eval:resumes -- --record    # same, and save the answers to fixtures/resume-llm-responses.json
 *   npm run eval:resumes -- --replay    # score the saved answers, no API calls
 *
 * Scoring is on what survives the grounding check, since that is what the
 * pipeline uses. Values are compared after the same clean-up the pipeline
 * does (case/spacing, dates to YYYY-MM, skill synonyms). Precision says how
 * many extracted items are right; recall says how many real items were found.
 * For a hiring record precision matters more: a wrong job is worse than a
 * missing one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import { readResumeText } from "../src/adapters/resume.js";
import { canon } from "../src/adapters/resume-grounding.js";
import {
  createClaudeExtractor,
  groundExtraction,
  ResumeExtraction,
  type ExtractOutcome,
} from "../src/adapters/resume-llm.js";
import { isPresentWord, normalizeDate } from "../src/normalizers/date.js";
import { normalizeSkill } from "../src/normalizers/skills.js";
import {
  fixtureFileName,
  RESUME_FIXTURES,
  type ResumeTruth,
} from "./resume-fixtures-data.js";

const RESPONSES_PATH = "fixtures/resume-llm-responses.json";

interface SavedResponses {
  note: string;
  responses: Record<string, { model: string; output: unknown }>;
}

type FieldName = "headline" | "skills" | "experience" | "education";
const FIELDS: FieldName[] = ["headline", "skills", "experience", "education"];

function text(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : canon(value);
}

function dateKey(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (isPresentWord(value)) {
    return "present";
  }
  return normalizeDate(value) ?? canon(value);
}

/** One comparable string per item, so precision/recall is a multiset match. */
function keysOf(truth: ResumeTruth): Record<FieldName, string[]> {
  return {
    headline: truth.headline === null ? [] : [text(truth.headline)],
    skills: truth.skills.map((skill) => text(normalizeSkill(skill))),
    experience: truth.experience.map((job) =>
      [text(job.company), text(job.title), dateKey(job.start), dateKey(job.end)].join(" | "),
    ),
    // Degree and field wording varies ("B.Tech" vs "B.Tech in"), so a degree
    // counts as found when the school and year match.
    education: truth.education.map((school) =>
      [text(school.institution), String(school.end_year ?? "")].join(" | "),
    ),
  };
}

/** Rebuilds a ResumeTruth from the facts that passed grounding. */
function groundedAsTruth(output: ResumeExtraction, resumeText: string) {
  const grounded = groundExtraction(output, resumeText, 0);
  const truth: ResumeTruth = { headline: null, skills: [], experience: [], education: [] };
  for (const fact of grounded.facts) {
    const value = fact.rawValue as never;
    if (fact.field === "headline") truth.headline = value;
    if (fact.field === "skills") truth.skills.push(value);
    if (fact.field === "experience.entry") truth.experience.push(value);
    if (fact.field === "education.entry") truth.education.push(value);
  }
  return { truth, dropped: grounded.droppedValues };
}

function matchCount(expected: string[], got: string[]): number {
  const left = [...expected];
  let matched = 0;
  for (const key of got) {
    const index = left.indexOf(key);
    if (index !== -1) {
      left.splice(index, 1);
      matched++;
    }
  }
  return matched;
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? "  n/a" : `${((100 * numerator) / denominator).toFixed(1).padStart(5)}%`;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const replay = args.has("--replay");
  const record = args.has("--record");

  const saved: SavedResponses = replay
    ? (JSON.parse(readFileSync(RESPONSES_PATH, "utf8")) as SavedResponses)
    : { note: "", responses: {} };
  const extractor = replay ? undefined : createClaudeExtractor();

  const totals = Object.fromEntries(
    FIELDS.map((field) => [field, { matched: 0, predicted: 0, expected: 0 }]),
  ) as Record<FieldName, { matched: number; predicted: number; expected: number }>;
  let dropped = 0;
  const models = new Set<string>();
  const recorded: SavedResponses["responses"] = {};

  for (const fixture of RESUME_FIXTURES) {
    const file = fixtureFileName(fixture);
    const read = await readResumeText(join("fixtures/resumes", file));
    if ("error" in read) {
      console.log(`${file}: cannot read (${read.error})`);
      continue;
    }

    let outcome: ExtractOutcome;
    if (extractor === undefined) {
      const entry = saved.responses[file];
      const parsed = ResumeExtraction.safeParse(entry?.output);
      outcome = parsed.success
        ? { ok: true, model: entry.model, output: parsed.data }
        : { ok: false, reason: "no saved answer" };
    } else {
      outcome = await extractor.extract(read.text);
    }

    if (!outcome.ok) {
      console.log(`${file}: extraction failed (${outcome.reason})`);
      for (const field of FIELDS) {
        totals[field].expected += keysOf(fixture.truth)[field].length;
      }
      continue;
    }
    models.add(outcome.model);
    recorded[file] = { model: outcome.model, output: outcome.output };

    const result = groundedAsTruth(outcome.output, read.text);
    dropped += result.dropped;
    const expected = keysOf(fixture.truth);
    const got = keysOf(result.truth);

    const misses: string[] = [];
    for (const field of FIELDS) {
      const matched = matchCount(expected[field], got[field]);
      totals[field].matched += matched;
      totals[field].predicted += got[field].length;
      totals[field].expected += expected[field].length;
      for (const key of got[field].filter((k) => !expected[field].includes(k))) {
        misses.push(`  extra    ${field}: ${key}`);
      }
      for (const key of expected[field].filter((k) => !got[field].includes(k))) {
        misses.push(`  missing  ${field}: ${key}`);
      }
    }
    console.log(`${file}: ${misses.length === 0 ? "all items match" : "differences:"}`);
    misses.forEach((line) => console.log(line));
  }

  console.log("");
  console.log(`Answers from: ${[...models].join(", ") || "none"}${replay ? ` (replayed from ${RESPONSES_PATH})` : ""}`);
  console.log("field        precision  recall   (matched / extracted / in answer key)");
  for (const field of FIELDS) {
    const t = totals[field];
    console.log(
      `${field.padEnd(12)} ${percent(t.matched, t.predicted)}    ${percent(t.matched, t.expected)}   (${t.matched} / ${t.predicted} / ${t.expected})`,
    );
  }
  console.log(`Values dropped by the grounding check: ${dropped}`);

  if (record && !replay) {
    const out: SavedResponses = {
      note: `Real answers recorded by 'npm run eval:resumes -- --record' on ${new Date().toISOString().slice(0, 10)}. Tests replay these; CI never calls the API.`,
      responses: recorded,
    };
    writeFileSync(RESPONSES_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    console.log(`Saved ${Object.keys(recorded).length} answers to ${RESPONSES_PATH}`);
  }
}

await main();
