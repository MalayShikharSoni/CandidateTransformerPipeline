import pLimit from "p-limit";
import { readCsvFacts } from "./adapters/csv.js";
import type { ResponseCache } from "./adapters/github-cache.js";
import {
  RateLimitState,
  readGitHubFacts,
  type FetchFn,
  type SourceWarning,
} from "./adapters/github.js";
import { groupFactsByCandidate } from "./merge/group.js";
import { resolveCandidateGroup } from "./merge/resolve.js";
import { normalizeFacts } from "./normalizers/index.js";
import { projectCandidate } from "./projection/project.js";
import type { ProjectionConfig } from "./schemas/config.js";
import type { RawFact } from "./schemas/raw-fact.js";
import { validateProjectedOutput } from "./validate/validate-output.js";

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

  // Sort so warning order doesn't depend on which request finished first.
  warnings.sort(
    (a, b) => a.username.localeCompare(b.username) || a.message.localeCompare(b.message),
  );

  return {
    facts,
    warnings,
    usernames: uniqueUsernames.length,
    cacheHits,
    rateLimitRemaining: rateLimit.remaining,
  };
}

function toOutputRecord(
  group: ReturnType<typeof groupFactsByCandidate>[number],
  config: ProjectionConfig,
): OutputRecord {
  const canonical = resolveCandidateGroup(group);
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

  const jobs = buildFetchJobs(bucketCsvFactsByRow(csv.facts), options.githubUser);
  const github: GitHubFetchResult =
    jobs.length > 0
      ? await fetchGitHubFactsForJobs(jobs, options)
      : { facts: [], warnings: [], usernames: 0, cacheHits: 0, rateLimitRemaining: null };

  const groups = groupFactsByCandidate(normalizeFacts([...csv.facts, ...github.facts]));
  const records = groups.map((group) => toOutputRecord(group, options.config));

  return {
    ok: true,
    records,
    warnings: github.warnings,
    stats: {
      csvRows: csv.rowCount,
      githubUsernames: github.usernames,
      githubUsernamesWithWarnings: new Set(github.warnings.map((w) => w.username)).size,
      githubCacheHits: github.cacheHits,
      githubRateLimitRemaining: github.rateLimitRemaining,
      candidates: records.length,
      candidateErrors: records.filter((record) => "error" in record).length,
    },
  };
}
