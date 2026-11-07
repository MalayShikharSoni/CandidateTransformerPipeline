import { readFileSync } from "node:fs";

/** Shape of fixtures/github-responses.json. */
export interface GitHubFixtures {
  full_profile: Record<string, unknown>;
  sparse_profile: Record<string, unknown>;
  not_found: Record<string, unknown>;
  full_profile_repos: Array<{ name: string; language: string | null }>;
}

export const githubFixtures = JSON.parse(
  readFileSync("fixtures/github-responses.json", "utf8"),
) as GitHubFixtures;

/** The URL a mocked fetch was called with, whatever form it was passed in. */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}
