import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A GitHub response body plus the ETag GitHub sent with it. */
export interface CachedResponse {
  etag: string;
  body: string;
}

/**
 * Stores GitHub responses so the next run can send `If-None-Match`.
 * GitHub then answers 304 Not Modified when nothing changed, and an
 * authenticated 304 does not count against the hourly rate limit.
 * Data is never stale: every run still asks GitHub, just conditionally.
 */
export interface ResponseCache {
  get(url: string): Promise<CachedResponse | undefined>;
  set(url: string, entry: CachedResponse): Promise<void>;
}

/** One JSON file per URL, named by a hash of the URL. */
export class FileResponseCache implements ResponseCache {
  constructor(private readonly dir: string) {}

  private pathFor(url: string): string {
    const name = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return join(this.dir, `${name}.json`);
  }

  async get(url: string): Promise<CachedResponse | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pathFor(url), "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "url" in parsed &&
        "etag" in parsed &&
        "body" in parsed &&
        parsed.url === url &&
        typeof parsed.etag === "string" &&
        typeof parsed.body === "string"
      ) {
        return { etag: parsed.etag, body: parsed.body };
      }
      return undefined;
    } catch {
      // Missing or corrupt file: behave as if nothing was cached.
      return undefined;
    }
  }

  async set(url: string, entry: CachedResponse): Promise<void> {
    const path = this.pathFor(url);
    // Write to a temp file, then rename, so a crash or a parallel run never
    // leaves a half-written cache file behind.
    const tempPath = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tempPath, JSON.stringify({ url, ...entry }), "utf8");
      await rename(tempPath, path);
    } catch {
      // A cache that can't be written must never fail the run.
    }
  }
}

/** In-memory cache, used by tests. */
export class MemoryResponseCache implements ResponseCache {
  readonly entries = new Map<string, CachedResponse>();

  get(url: string): Promise<CachedResponse | undefined> {
    return Promise.resolve(this.entries.get(url));
  }

  set(url: string, entry: CachedResponse): Promise<void> {
    this.entries.set(url, entry);
    return Promise.resolve();
  }
}
