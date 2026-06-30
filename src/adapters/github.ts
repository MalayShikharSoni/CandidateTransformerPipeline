import type { RawFact } from "../schemas/raw-fact.js";

const GITHUB_USER_API = "https://api.github.com/users";

export interface GitHubAdapterResult {
  facts: RawFact[];
}

export type FetchFn = typeof fetch;

export interface ReadGitHubFactsOptions {
  fetch?: FetchFn;
  token?: string;
  /** Source-local bundle id for this API call. Defaults to 0. */
  callIndex?: number;
}

interface GitHubUserProfile {
  name?: string | null;
  bio?: string | null;
  html_url?: string | null;
  blog?: string | null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function resolveToken(options?: ReadGitHubFactsOptions): string | undefined {
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

function profileToFacts(profile: GitHubUserProfile, rowIndex: number): RawFact[] {
  const facts: RawFact[] = [];

  const name = nonEmpty(profile.name);
  if (name !== undefined) {
    facts.push({
      field: "full_name",
      rawValue: name,
      source: "github",
      sourceMethod: "github_field:name",
      rowIndex,
    });
  }

  const bio = nonEmpty(profile.bio);
  if (bio !== undefined) {
    facts.push({
      field: "headline",
      rawValue: bio,
      source: "github",
      sourceMethod: "github_field:bio",
      rowIndex,
    });
  }

  const htmlUrl = nonEmpty(profile.html_url);
  if (htmlUrl !== undefined) {
    facts.push({
      field: "links.github",
      rawValue: htmlUrl,
      source: "github",
      sourceMethod: "github_field:html_url",
      rowIndex,
    });
  }

  const blog = nonEmpty(profile.blog);
  if (blog !== undefined) {
    facts.push({
      field: "links.portfolio",
      rawValue: blog,
      source: "github",
      sourceMethod: "github_field:blog",
      rowIndex,
    });
  }

  // Skills from public repo languages are not available on GET /users/{username}.
  // Fetching languages requires GET /users/{username}/repos plus per-repo
  // GET /repos/{owner}/{repo}/languages — an N+1 call pattern deferred here.
  // GitHub-derived skills are omitted until a multi-request ingest path is added.

  return facts;
}

export async function readGitHubFacts(
  username: string,
  options?: ReadGitHubFactsOptions,
): Promise<GitHubAdapterResult> {
  const trimmedUsername = username.trim();
  if (trimmedUsername === "") {
    return { facts: [] };
  }

  const fetchFn = options?.fetch ?? fetch;

  try {
    const response = await fetchFn(`${GITHUB_USER_API}/${trimmedUsername}`, {
      headers: buildGitHubHeaders(resolveToken(options)),
    });

    const rawBody = await response.text();

    if (!response.ok) {
      return { facts: [] };
    }

    let profile: unknown;
    try {
      profile = JSON.parse(rawBody);
    } catch {
      return { facts: [] };
    }

    if (!profile || typeof profile !== "object") {
      return { facts: [] };
    }

    return {
      facts: profileToFacts(profile as GitHubUserProfile, options?.callIndex ?? 0),
    };
  } catch {
    return { facts: [] };
  }
}
