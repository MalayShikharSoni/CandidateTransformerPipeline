import type { RawFact } from "../schemas/raw-fact.js";

const GITHUB_USER_API = "https://api.github.com/users";

/** Longest we will pause for a rate-limit retry. Longer waits are reported, not waited out. */
const MAX_RETRY_WAIT_MS = 60_000;

/** Something went wrong with a source, but the run carried on without it. */
export interface SourceWarning {
  source: "github";
  username: string;
  message: string;
}

export interface GitHubAdapterResult {
  facts: RawFact[];
  warnings: SourceWarning[];
}

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Shared by every GitHub call in one run. GitHub sends the remaining hourly
 * budget on each response; once it hits 0, later calls are skipped instead of
 * being sent and failing one by one.
 */
export class RateLimitState {
  remaining: number | null = null;
  resetAt: Date | null = null;

  update(headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining") ?? Number.NaN);
    const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
    if (Number.isNaN(remaining) || Number.isNaN(reset)) {
      return;
    }

    const resetAt = new Date(reset * 1000);
    const sameWindow = this.resetAt?.getTime() === resetAt.getTime();

    // Responses from parallel calls can arrive out of order, so within one
    // window keep the lowest count seen rather than the latest one.
    this.remaining =
      sameWindow && this.remaining !== null
        ? Math.min(this.remaining, remaining)
        : remaining;
    this.resetAt = resetAt;
  }

  isExhausted(now: number = Date.now()): boolean {
    return (
      this.remaining === 0 &&
      this.resetAt !== null &&
      this.resetAt.getTime() > now
    );
  }
}

export interface ReadGitHubFactsOptions {
  fetch?: FetchFn;
  token?: string;
  /** Source-local bundle id for this API call. Defaults to 0. */
  callIndex?: number;
  /** Pass one instance to every call in a run so they share the budget. */
  rateLimit?: RateLimitState;
  /** Injected in tests so retries don't really wait. */
  sleep?: SleepFn;
}

interface GitHubUserProfile {
  name?: string | null;
  bio?: string | null;
  html_url?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
}

interface GitHubRepo {
  language?: string | null;
}

interface CallContext {
  fetchFn: FetchFn;
  headers: Record<string, string>;
  rateLimit: RateLimitState;
  sleep: SleepFn;
}

type CallResult = { ok: true; body: unknown } | { ok: false; reason: string };

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function resolveToken(options?: ReadGitHubFactsOptions): string | undefined {
  if (options?.token !== undefined) {
    const trimmed = options.token.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const trimmed = fromEnv?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function buildGitHubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "candidate-data-transformer",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after"))
  );
}

/** How long GitHub asked us to wait before retrying, or null if this isn't a rate limit. */
function retryWaitMs(response: Response, now: number = Date.now()): number | null {
  if (!isRateLimited(response)) {
    return null;
  }

  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  if (!Number.isNaN(retryAfter)) {
    return retryAfter * 1000;
  }

  const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (!Number.isNaN(reset)) {
    return Math.max(0, reset * 1000 - now);
  }

  return null;
}

function describeFailure(response: Response, rateLimit: RateLimitState): string {
  const status = response.status;

  if (status === 401) {
    return "GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN in .env.";
  }
  if (isRateLimited(response)) {
    const resetText =
      rateLimit.resetAt !== null ? `; resets at ${rateLimit.resetAt.toISOString()}` : "";
    return `GitHub rate limit reached (HTTP ${status})${resetText}.`;
  }
  if (status === 403) {
    return "GitHub refused the request (HTTP 403).";
  }
  if (status === 404) {
    return "GitHub user not found (HTTP 404).";
  }
  return `GitHub returned HTTP ${status}.`;
}

async function sendOnce(
  url: string,
  ctx: CallContext,
): Promise<{ response: Response; body: string } | { error: string }> {
  try {
    const response = await ctx.fetchFn(url, { headers: ctx.headers });
    ctx.rateLimit.update(response.headers);
    const body = await response.text();
    return { response, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Network error calling GitHub: ${message}` };
  }
}

/** One GET to GitHub, with at most one retry when GitHub asks us to slow down. */
async function callGitHub(url: string, ctx: CallContext): Promise<CallResult> {
  if (ctx.rateLimit.isExhausted()) {
    const resetAt = ctx.rateLimit.resetAt?.toISOString() ?? "unknown";
    return {
      ok: false,
      reason: `Skipped: GitHub rate limit used up until ${resetAt}.`,
    };
  }

  let attempt = await sendOnce(url, ctx);
  if ("error" in attempt) {
    return { ok: false, reason: attempt.error };
  }

  const waitMs = retryWaitMs(attempt.response);
  if (waitMs !== null && waitMs <= MAX_RETRY_WAIT_MS) {
    await ctx.sleep(waitMs);
    attempt = await sendOnce(url, ctx);
    if ("error" in attempt) {
      return { ok: false, reason: attempt.error };
    }
  }

  if (!attempt.response.ok) {
    return { ok: false, reason: describeFailure(attempt.response, ctx.rateLimit) };
  }

  try {
    return { ok: true, body: JSON.parse(attempt.body) };
  } catch {
    return { ok: false, reason: "GitHub response was not valid JSON." };
  }
}

function profileToFacts(profile: GitHubUserProfile, rowIndex: number): RawFact[] {
  const facts: RawFact[] = [];

  const fieldMap: Array<[keyof GitHubUserProfile, string]> = [
    ["name", "full_name"],
    ["bio", "headline"],
    ["html_url", "links.github"],
    ["blog", "links.portfolio"],
    ["location", "location.raw"],
    ["email", "emails"],
  ];

  for (const [githubField, canonicalField] of fieldMap) {
    const value = nonEmpty(profile[githubField]);
    if (value === undefined) {
      continue;
    }
    facts.push({
      field: canonicalField,
      rawValue: value,
      source: "github",
      sourceMethod: `github_field:${githubField}`,
      rowIndex,
    });
  }

  return facts;
}

function reposToSkillFacts(repos: GitHubRepo[], rowIndex: number): RawFact[] {
  const seen = new Set<string>();
  const facts: RawFact[] = [];

  for (const repo of repos) {
    const language = nonEmpty(repo.language);
    if (language === undefined || seen.has(language)) {
      continue;
    }

    seen.add(language);
    facts.push({
      field: "skills",
      rawValue: language,
      source: "github",
      sourceMethod: "github_field:repo_language",
      rowIndex,
    });
  }

  return facts;
}

export async function readGitHubFacts(
  username: string,
  options?: ReadGitHubFactsOptions,
): Promise<GitHubAdapterResult> {
  const trimmedUsername = username.trim();
  if (trimmedUsername === "") {
    return { facts: [], warnings: [] };
  }

  const ctx: CallContext = {
    fetchFn: options?.fetch ?? fetch,
    headers: buildGitHubHeaders(resolveToken(options)),
    rateLimit: options?.rateLimit ?? new RateLimitState(),
    sleep: options?.sleep ?? defaultSleep,
  };
  const rowIndex = options?.callIndex ?? 0;
  const userUrl = `${GITHUB_USER_API}/${encodeURIComponent(trimmedUsername)}`;
  const warn = (message: string): SourceWarning => ({
    source: "github",
    username: trimmedUsername,
    message,
  });

  const profile = await callGitHub(userUrl, ctx);
  if (!profile.ok) {
    return { facts: [], warnings: [warn(profile.reason)] };
  }
  if (!profile.body || typeof profile.body !== "object") {
    return { facts: [], warnings: [warn("GitHub profile response was not an object.")] };
  }

  const profileFacts = profileToFacts(profile.body as GitHubUserProfile, rowIndex);

  // Skills are a bonus: if the repo call fails we keep the profile facts.
  const repos = await callGitHub(`${userUrl}/repos?per_page=10&sort=updated`, ctx);
  if (!repos.ok) {
    return {
      facts: profileFacts,
      warnings: [warn(`Could not read repos for skills. ${repos.reason}`)],
    };
  }
  if (!Array.isArray(repos.body)) {
    return {
      facts: profileFacts,
      warnings: [warn("GitHub repos response was not a list.")],
    };
  }

  return {
    facts: [...profileFacts, ...reposToSkillFacts(repos.body as GitHubRepo[], rowIndex)],
    warnings: [],
  };
}
