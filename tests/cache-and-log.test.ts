import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileResponseCache, MemoryResponseCache } from "../src/adapters/github-cache.js";
import { readGitHubFacts } from "../src/adapters/github.js";
import { createLogger } from "../src/log.js";
import type { PipelineStats } from "../src/pipeline.js";
import { requestUrl } from "./helpers.js";

const PROFILE = { name: "Aditi Rao", bio: "Engineer", html_url: "https://github.com/aditi" };
const REPOS = [{ language: "Go" }];

/** Fake GitHub that supports ETags: answers 304 when If-None-Match matches. */
function etagServer() {
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = requestUrl(url);
    const headers = new Headers(init?.headers);
    const ifNoneMatch = headers.get("if-none-match");
    requests.push({ url: href, ifNoneMatch });

    const isRepos = href.includes("/repos");
    const etag = isRepos ? '"repos-v1"' : '"profile-v1"';
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify(isRepos ? REPOS : PROFILE), {
      status: 200,
      headers: { etag },
    });
  });
  return { fetch, requests };
}

describe("GitHub ETag cache", () => {
  it("revalidates with If-None-Match and reuses the cached body on 304", async () => {
    const { fetch, requests } = etagServer();
    const cache = new MemoryResponseCache();

    const first = await readGitHubFacts("aditi", { fetch, cache });
    const second = await readGitHubFacts("aditi", { fetch, cache });

    expect(first.cacheHits).toBe(0);
    expect(second.cacheHits).toBe(2);
    expect(requests.slice(2).map((r) => r.ifNoneMatch)).toEqual(['"profile-v1"', '"repos-v1"']);
    // Same facts whether the body came from the network or the cache.
    expect(second.facts).toEqual(first.facts);
  });

  it("does not cache failed responses", async () => {
    const cache = new MemoryResponseCache();
    const fetch = vi.fn(async () => new Response("{}", { status: 500, headers: { etag: '"x"' } }));

    await readGitHubFacts("aditi", { fetch, cache });

    expect(cache.entries.size).toBe(0);
  });
});

describe("FileResponseCache", () => {
  it("round-trips an entry through disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdt-cache-"));
    const cache = new FileResponseCache(dir);

    await cache.set("https://api.github.com/users/a", { etag: '"1"', body: "{}" });

    expect(await cache.get("https://api.github.com/users/a")).toEqual({ etag: '"1"', body: "{}" });
    expect(await cache.get("https://api.github.com/users/b")).toBeUndefined();
    // Only the final file is left, no temp files.
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("treats a corrupt cache file as a miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdt-cache-"));
    const cache = new FileResponseCache(dir);
    await cache.set("https://api.github.com/users/a", { etag: '"1"', body: "{}" });
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file), "not json");

    expect(await cache.get("https://api.github.com/users/a")).toBeUndefined();
  });
});

describe("createLogger", () => {
  const stats: PipelineStats = {
    csvRows: 4,
    githubUsernames: 1,
    githubUsernamesWithWarnings: 0,
    githubCacheHits: 2,
    githubRateLimitRemaining: 4998,
    candidates: 4,
    candidateErrors: 0,
  };

  it("writes a one-line text summary", () => {
    const lines: string[] = [];
    createLogger("text", (line) => lines.push(line)).summary(stats, 123.4);

    expect(lines).toEqual([
      "summary: 4 CSV rows -> 4 candidates (0 errors) | GitHub: 1 username, 0 with warnings, 2 cache hits, 4998 requests left this hour | 123 ms",
    ]);
  });

  it("writes one JSON object per line in json mode", () => {
    const lines: string[] = [];
    const log = createLogger("json", (line) => lines.push(line));
    log.warning({ source: "github", username: "x", message: "boom" });
    log.summary(stats, 10);

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]).toEqual({
      level: "warn",
      event: "source_warning",
      source: "github",
      username: "x",
      message: "boom",
    });
    expect(parsed[1]).toMatchObject({ event: "run_summary", csvRows: 4, durationMs: 10 });
  });
});
