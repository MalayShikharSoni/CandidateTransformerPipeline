import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Stores LLM extraction results by content: the key is a hash of the model,
 * the prompt version and the resume text. The same resume therefore replays
 * the same answer on every later run, which keeps output reproducible even
 * though the model call itself is not deterministic. Changing the prompt or
 * the model changes the key, so a stale answer is never reused.
 */
export interface LlmCacheEntry {
  /** The model that actually answered (a refusal fallback may differ from the one asked). */
  model: string;
  /** The parsed, not yet grounded, model output. */
  output: unknown;
}

export interface LlmCache {
  get(key: string): Promise<LlmCacheEntry | undefined>;
  set(key: string, entry: LlmCacheEntry): Promise<void>;
}

export function llmCacheKey(parts: { model: string; promptVersion: string; text: string }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.model, parts.promptVersion, parts.text]))
    .digest("hex");
}

/** One JSON file per key. Same atomic write as FileResponseCache (github-cache.ts). */
export class FileLlmCache implements LlmCache {
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<LlmCacheEntry | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pathFor(key), "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "key" in parsed &&
        "model" in parsed &&
        "output" in parsed &&
        parsed.key === key &&
        typeof parsed.model === "string"
      ) {
        return { model: parsed.model, output: parsed.output };
      }
      return undefined;
    } catch {
      // Missing or corrupt file: behave as if nothing was cached.
      return undefined;
    }
  }

  async set(key: string, entry: LlmCacheEntry): Promise<void> {
    const path = this.pathFor(key);
    const tempPath = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tempPath, JSON.stringify({ key, ...entry }, null, 2), "utf8");
      await rename(tempPath, path);
    } catch {
      // A cache that can't be written must never fail the run.
    }
  }
}

/** In-memory cache, used by tests. */
export class MemoryLlmCache implements LlmCache {
  readonly entries = new Map<string, LlmCacheEntry>();

  get(key: string): Promise<LlmCacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: LlmCacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }
}
