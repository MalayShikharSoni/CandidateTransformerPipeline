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
  location?: string | null;
  email?: string | null;
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

  const location = nonEmpty(profile.location);
  if (location !== undefined) {
    facts.push({
      field: "location.raw",
      rawValue: location,
      source: "github",
      sourceMethod: "github_field:location",
      rowIndex,
    });
  }

  const email = nonEmpty(profile.email);
  if (email !== undefined) {
    facts.push({
      field: "emails",
      rawValue: email,
      source: "github",
      sourceMethod: "github_field:email",
      rowIndex,
    });
  }

  return facts;
}

interface GitHubRepo {
  language?: string | null;
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

async function fetchRepoSkillFacts(
  fetchFn: FetchFn,
  username: string,
  rowIndex: number,
  headers: Record<string, string>,
): Promise<RawFact[]> {
  try {
    const response = await fetchFn(
      `${GITHUB_USER_API}/${username}/repos?per_page=10&sort=updated`,
      { headers },
    );
    const rawBody = await response.text();

    if (!response.ok) {
      return [];
    }

    let repos: unknown;
    try {
      repos = JSON.parse(rawBody);
    } catch {
      return [];
    }

    if (!Array.isArray(repos)) {
      return [];
    }

    return reposToSkillFacts(repos as GitHubRepo[], rowIndex);
  } catch {
    return [];
  }
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
  const headers = buildGitHubHeaders(resolveToken(options));
  const rowIndex = options?.callIndex ?? 0;

  try {
    const response = await fetchFn(`${GITHUB_USER_API}/${trimmedUsername}`, {
      headers,
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

    const profileFacts = profileToFacts(profile as GitHubUserProfile, rowIndex);
    const skillFacts = await fetchRepoSkillFacts(
      fetchFn,
      trimmedUsername,
      rowIndex,
      headers,
    );

    return {
      facts: [...profileFacts, ...skillFacts],
    };
  } catch {
    return { facts: [] };
  }
}
