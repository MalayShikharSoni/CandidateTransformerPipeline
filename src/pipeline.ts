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
import { resolveCandidateGroup } from "./merge/resolve.js";
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
  | { ok: true; records: OutputRecord[]; warnings: SourceWarning[]; stats: PipelineStats }
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
  const jobs: Array<{ rowIndex: number; path: string; shownAs: string }> = [];
  for (const [rowIndex, rowFacts] of rowBuckets) {
    const shownAs = resumePathFromRow(rowFacts);
    if (shownAs !== undefined) {
      const path = isAbsolute(shownAs) ? shownAs : resolvePath(csvDir, shownAs);
      jobs.push({ rowIndex, path, shownAs });
    }
  }

  const limit = pLimit(RESUME_CONCURRENCY);
  const results = await Promise.all(
    jobs.map((job) =>
      limit(() =>
        readResumeFacts(job.path, {
          rowIndex: job.rowIndex,
          subject: job.shownAs,
          extract: options.extractResume,
          cache: options.llmCache,
        }),
      ),
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

function toOutputRecord(
  group: ReturnType<typeof groupFactsByCandidate>[number],
  config: ProjectionConfig,
  asOf: string,
): OutputRecord {
  const canonical = resolveCandidateGroup(group, asOf);
  const projected = projectCandidate(canonical, config);
  if ("error" in projected) {
    return { error: projected.error };
  }

  const validated = validateProjectedOutput(projected, config);
  return validated.ok ? validated.data : { error: validated.error };
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
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

  const groups = groupFactsByCandidate(
    normalizeFacts([...csv.facts, ...resumes.facts, ...github.facts]),
  );
  const asOf = options.asOf ?? currentMonth();
  const records = groups.map((group) => toOutputRecord(group, options.config, asOf));

  return {
    ok: true,
    records,
    warnings: sortWarnings([...github.warnings, ...resumes.warnings]),
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
  };
}
