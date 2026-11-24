import "dotenv/config";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { FileResponseCache } from "../adapters/github-cache.js";
import { resolveToken } from "../adapters/github.js";
import { FileLlmCache } from "../adapters/llm-cache.js";
import { createClaudeExtractor } from "../adapters/resume-llm.js";
import { createReplayExtractor } from "../adapters/resume-replay.js";
import { createApp } from "./app.js";

/**
 * Starts the web app: the API plus the built pages from web/dist. A thin
 * wrapper like cli.ts — the logic lives in app.ts and run.ts.
 */

// --port wins over PORT, so `npm run dev` can pin the API next to Vite even
// when the environment sets PORT for the front end. --replay = REPLAY_LLM=1.
const { values: args } = parseArgs({
  options: { port: { type: "string" }, replay: { type: "boolean" } },
  strict: false,
});
const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
const replay = process.env.REPLAY_LLM === "1" || args.replay === true;
const cacheDir = process.env.CACHE_DIR ?? ".cache";

// Without a key, LLM runs fall back to regex-only and say so. REPLAY_LLM=1
// (dev only) plays back the saved answers in fixtures/ instead of calling Claude.
const extractor = replay
  ? await createReplayExtractor("fixtures/resume-llm-responses.json", "fixtures/resumes")
  : anthropicKey
    ? createClaudeExtractor()
    : undefined;
if (replay) console.warn("REPLAY_LLM=1: LLM runs replay saved answers from fixtures/, no API calls.");

const app = createApp({
  env: { anthropicKey: anthropicKey || replay, githubToken: resolveToken() !== undefined },
  llmMode: replay ? "replay" : anthropicKey ? "claude" : "off",
  extractor,
  githubCache: new FileResponseCache(`${cacheDir}/github`),
  // Replayed answers must not land in the real cache.
  llmCache: replay ? undefined : new FileLlmCache(`${cacheDir}/llm`),
});

// src/server/main.ts and dist/server/main.js both sit two levels below the repo root.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  const root = relative(process.cwd(), webDist) || ".";
  const assets = serveStatic({ root });
  const indexPage = serveStatic({ root, path: "index.html" });
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : assets(c, next)));
  // Single-page app: any other page path gets index.html.
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : indexPage(c, next)));
} else {
  console.warn("web/dist not found: serving the API only. Run `npm run build` for the pages.");
}

const port = Number(typeof args.port === "string" ? args.port : (process.env.PORT ?? 8787));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`CanonVerge listening on http://localhost:${info.port}`);
});
