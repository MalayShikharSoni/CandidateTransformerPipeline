import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import pLimit from "p-limit";
import { readCsvFacts } from "./adapters/csv.js";
import type { ResponseCache } from "./adapters/github-cache.js";
import {
  RateLimitState,
  readGitHubFacts,
  type FetchFn,
  type SourceWarning,
} from "./adapters/github.js";
import type { LlmCache } from "./adapters/llm-cache.js";
import { readResumeFacts } from "./adapters/resume.js";
import type { ResumeExtractor } from "./adapters/resume-llm.js";
import { groupFactsByCandidate } from "./merge/group.js";
import { resolveCandidateDetailed, type FieldConfidence } from "./merge/resolve.js";
import { normalizeFacts } from "./normalizers/index.js";
import { projectCandidate } from "./projection/project.js";
import type { ProjectionConfig } from "./schemas/config.js";
import type { RawFact } from "./schemas/raw-fact.js";
import { validateProjectedOutput } from "./validate/validate-output.js";
import { sortWarnings } from "./adapters/warnings.js";

/**
 * The whole pipeline as one function with no console or process access, so
 * the CLI, the tests and the benchmark all run exactly the same code.
 */

export interface PipelineOptions {
  csvPath: string;
  config: ProjectionConfig;
  /** One username for every row (the --github flag). Otherwise each row's github_username. */
  githubUser?: string;
  /** Injected by tests and the benchmark. Defaults to the global fetch. */
  fetch?: FetchFn;
  cache?: ResponseCache;
  /** Max GitHub requests in flight at once. */
  concurrency?: number;
  /**
   * Reads jobs, degrees, headline and skills from resumes with an LLM (the
   * --llm flag). Without it, resumes contribute only regex facts.
   */
  extractResume?: ResumeExtractor;
  llmCache?: LlmCache;
  /** YYYY-MM that ongoing jobs run to for years_experience. Defaults to the current UTC month. */
  asOf?: string;
  /**
   * Maps a resume_path from the CSV to a file to read, or undefined when there
   * is none. The web server matches uploaded files by name, so a CSV can never
   * point it at other files on the server. Default: relative to the CSV's folder.
   */
  resolveResumePath?: (shownAs: string) => string | undefined;
  /** Progress callback: stage starts and ends, each source read, warnings. */
  onEvent?: (event: PipelineEvent) => void;
  /** Also return per-field confidences (result.details). */
  includeFieldConfidence?: boolean;
}

export const STAGES = [
  "ingest",
  "extract",
  "normalize",
  "merge",
  "confidence",
  "project",
  "validate",
  "emit",
] as const;
export type StageName = (typeof STAGES)[number];

export type PipelineEvent =
  | { type: "stage"; stage: StageName; status: "start" | "done" }
  | { type: "source"; source: "github" | "resume"; subject: string; ok: boolean }
  | { type: "warning"; warning: SourceWarning };

export interface CandidateDetail {
  candidate_id: string;
  fieldConfidence: FieldConfidence;
}

/** One output record: the projected candidate, or why it could not be produced. */
export type OutputRecord = Record<string, unknown> | { error: string };

export interface PipelineStats {
  csvRows: number;
  githubUsernames: number;
  githubUsernamesWithWarnings: number;
  githubCacheHits: number;
  /** Last known GitHub hourly budget left, or null if no call was made. */
  githubRateLimitRemaining: number | null;
  /** Resume files named in the CSV (resume_path column). */
  resumes: number;
  resumesWithWarnings: number;
  resumeLlmCalls: number;
  resumeLlmCacheHits: number;
  /** LLM items or values removed because they are not in the resume text. */
  resumeValuesDropped: number;
  candidates: number;
  candidateErrors: number;
}

export type PipelineResult =
  | {
      ok: true;
      records: OutputRecord[];
      warnings: SourceWarning[];
      stats: PipelineStats;
      /** Same order as records; only with includeFieldConfidence. */
      details?: CandidateDetail[];
    }
  | { ok: false; error: string };

interface FetchJob {
  rowIndex: number;
  username: string;
  /** true when the username came from this row's github_username column, not --github. */
  linkedFromRow: boolean;
}

const DEFAULT_CONCURRENCY = 10;
/** LLM calls are slower and pricier; keep fewer in flight. */
const RESUME_CONCURRENCY = 4;

function bucketCsvFactsByRow(facts: RawFact[]): Map<number, RawFact[]> {
  const buckets = new Map<number, RawFact[]>();

  for (const fact of facts) {
    const bucket = buckets.get(fact.rowIndex);
    if (bucket === undefined) {
      buckets.set(fact.rowIndex, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  return buckets;
}

function githubUsernameFromRow(rowFacts: RawFact[]): string | undefined {
  for (const fact of rowFacts) {
    if (fact.field !== "links.github_username" || typeof fact.rawValue !== "string") {
      continue;
    }
    const trimmed = fact.rawValue.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }

  return undefined;
}

function resumePathFromRow(rowFacts: RawFact[]): string | undefined {
  for (const fact of rowFacts) {
    if (fact.field === "resume_path" && typeof fact.rawValue === "string") {
      const trimmed = fact.rawValue.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return undefined;
}

interface ResumeReadResult {
  facts: RawFact[];
  warnings: SourceWarning[];
  files: number;
  llmCalls: number;
  llmCacheHits: number;
  valuesDropped: number;
}

/** Reads every resume named in the CSV. A path is relative to the CSV's folder. */
async function readResumesForRows(
  rowBuckets: Map<number, RawFact[]>,
  options: PipelineOptions,
): Promise<ResumeReadResult> {
  const csvDir = dirname(options.csvPath);
  const resolveDefault = (shownAs: string) =>
    isAbsolute(shownAs) ? shownAs : resolvePath(csvDir, shownAs);
  const resolveFile = options.resolveResumePath ?? resolveDefault;
  const jobs: Array<{ rowIndex: number; path: string | undefined; shownAs: string }> = [];
  for (const [rowIndex, rowFacts] of rowBuckets) {
    const shownAs = resumePathFromRow(rowFacts);
    if (shownAs !== undefined) {
      jobs.push({ rowIndex, path: resolveFile(shownAs), shownAs });
    }
  }

  const limit = pLimit(RESUME_CONCURRENCY);
  const results = await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        const result =
          job.path === undefined
            ? {
                facts: [],
                warnings: [
                  {
                    source: "resume" as const,
                    subject: job.shownAs,
                    message: "no uploaded file has this name.",
                  },
                ],
                llmCalled: false,
                llmCacheHit: false,
                droppedValues: 0,
              }
            : await readResumeFacts(job.path, {
                rowIndex: job.rowIndex,
                subject: job.shownAs,
                extract: options.extractResume,
                cache: options.llmCache,
              });
        options.onEvent?.({
          type: "source",
          source: "resume",
          subject: job.shownAs,
          ok: result.warnings.length === 0,
        });
        return result;
      }),
    ),
  );

  return {
    // Promise.all keeps job order, so facts stay in CSV row order.
    facts: results.flatMap((result) => result.facts),
    warnings: results.flatMap((result) => result.warnings),
    files: jobs.length,
    llmCalls: results.filter((result) => result.llmCalled).length,
    llmCacheHits: results.filter((result) => result.llmCacheHit).length,
    valuesDropped: results.reduce((sum, result) => sum + result.droppedValues, 0),
  };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function buildFetchJobs(
  rowBuckets: Map<number, RawFact[]>,
  globalGithubUser?: string,
): FetchJob[] {
  const jobs: FetchJob[] = [];

  for (const [rowIndex, rowFacts] of rowBuckets) {
    const username = globalGithubUser ?? githubUsernameFromRow(rowFacts);
    if (username === undefined) {
      continue;
    }

    jobs.push({ rowIndex, username, linkedFromRow: globalGithubUser === undefined });
  }

  return jobs;
}

interface GitHubFetchResult {
  facts: RawFact[];
  warnings: SourceWarning[];
  usernames: number;
  cacheHits: number;
  rateLimitRemaining: number | null;
}

async function fetchGitHubFactsForJobs(
  jobs: FetchJob[],
  options: PipelineOptions,
): Promise<GitHubFetchResult> {
  // Each username is fetched once, even if several rows name it.
  const uniqueUsernames = [...new Set(jobs.map((job) => job.username))];
  // p-limit caps how many requests are in flight at once. The hourly budget
  // is a separate limit, tracked by the shared RateLimitState.
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  const rateLimit = new RateLimitState();
  const factsByUsername = new Map<string, RawFact[]>();
  const warnings: SourceWarning[] = [];
  let cacheHits = 0;

  await Promise.all(
    uniqueUsernames.map((username) =>
      limit(async () => {
        const result = await readGitHubFacts(username, {
          rateLimit,
          fetch: options.fetch,
          cache: options.cache,
        });
        factsByUsername.set(username, result.facts);
        warnings.push(...result.warnings);
        cacheHits += result.cacheHits;
        options.onEvent?.({
          type: "source",
          source: "github",
          subject: username,
          ok: result.warnings.length === 0,
        });
      }),
    ),
  );

  // Stamp each fetched fact with the CSV row it belongs to (see merge/group.ts).
  const facts: RawFact[] = [];
  for (const { rowIndex, username, linkedFromRow } of jobs) {
    for (const fact of factsByUsername.get(username) ?? []) {
      facts.push({ ...fact, rowIndex, rowLinked: linkedFromRow });
    }
  }

  return {
    facts,
    warnings: sortWarnings(warnings),
    usernames: uniqueUsernames.length,
    cacheHits,
    rateLimitRemaining: rateLimit.remaining,
  };
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const emit = options.onEvent ?? (() => undefined);
  const stage = <T>(name: StageName, work: () => T): T => {
    emit({ type: "stage", stage: name, status: "start" });
    const result = work();
    emit({ type: "stage", stage: name, status: "done" });
    return result;
  };

  emit({ type: "stage", stage: "ingest", status: "start" });
  const csv = await readCsvFacts(options.csvPath);
  if (csv.error !== undefined) {
    return { ok: false, error: csv.error };
  }

  const rowBuckets = bucketCsvFactsByRow(csv.facts);
  const jobs = buildFetchJobs(rowBuckets, options.githubUser);
  // GitHub and resumes are independent, so read them at the same time.
  const [github, resumes] = await Promise.all([
    jobs.length > 0
      ? fetchGitHubFactsForJobs(jobs, options)
      : Promise.resolve<GitHubFetchResult>({
          facts: [],
          warnings: [],
          usernames: 0,
          cacheHits: 0,
          rateLimitRemaining: null,
        }),
    readResumesForRows(rowBuckets, options),
  ]);
  const warnings = sortWarnings([...github.warnings, ...resumes.warnings]);
  for (const warning of warnings) {
    emit({ type: "warning", warning });
  }
  emit({ type: "stage", stage: "ingest", status: "done" });

  // Every source already mapped its data to RawFacts while being read; this
  // stage just pools them.
  const facts = stage("extract", () => [...csv.facts, ...resumes.facts, ...github.facts]);
  const normalized = stage("normalize", () => normalizeFacts(facts));
  const groups = stage("merge", () => groupFactsByCandidate(normalized));
  const asOf = options.asOf ?? currentMonth();
  const resolved = stage("confidence", () =>
    groups.map((group) => resolveCandidateDetailed(group, asOf)),
  );
  const projected = stage("project", () =>
    resolved.map(({ canonical }) => projectCandidate(canonical, options.config)),
  );
  const records = stage("validate", () =>
    projected.map((record): OutputRecord => {
      if ("error" in record) {
        return { error: record.error };
      }
      const validated = validateProjectedOutput(record, options.config);
      return validated.ok ? validated.data : { error: validated.error };
    }),
  );

  emit({ type: "stage", stage: "emit", status: "start" });
  const result: PipelineResult = {
    ok: true,
    records,
    warnings,
    stats: {
      csvRows: csv.rowCount,
      githubUsernames: github.usernames,
      githubUsernamesWithWarnings: new Set(github.warnings.map((w) => w.subject)).size,
      githubCacheHits: github.cacheHits,
      githubRateLimitRemaining: github.rateLimitRemaining,
      resumes: resumes.files,
      resumesWithWarnings: new Set(resumes.warnings.map((w) => w.subject)).size,
      resumeLlmCalls: resumes.llmCalls,
      resumeLlmCacheHits: resumes.llmCacheHits,
      resumeValuesDropped: resumes.valuesDropped,
      candidates: records.length,
      candidateErrors: records.filter((record) => "error" in record).length,
    },
    details: options.includeFieldConfidence
      ? resolved.map(({ canonical, fieldConfidence }) => ({
          candidate_id: canonical.candidate_id,
          fieldConfidence,
        }))
      : undefined,
  };
  emit({ type: "stage", stage: "emit", status: "done" });
  return result;
}
