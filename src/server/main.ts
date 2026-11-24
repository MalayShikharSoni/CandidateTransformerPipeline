import "dotenv/config";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { FileResponseCache } from "../adapters/github-cache.js";
import { resolveToken } from "../adapters/github.js";
import { FileLlmCache } from "../adapters/llm-cache.js";
import { createClaudeExtractor } from "../adapters/resume-llm.js";
import { createReplayExtractor } from "../adapters/resume-replay.js";
import { createApp } from "./app.js";
import { serveApp } from "./static.js";

/**
 * Starts the web app: the API plus the built pages from web/dist. A thin
 * wrapper like cli.ts — the logic lives in app.ts, run.ts and static.ts.
 * Every setting comes from the environment (see the README's env table).
 */

// --port wins over PORT, so `npm run dev` can pin the API next to Vite even
// when the environment sets PORT for the front end. --replay = LLM_DEMO=1.
const { values: args } = parseArgs({
  options: { port: { type: "string" }, replay: { type: "boolean" } },
  strict: false,
});

const env = process.env;
const production = env.NODE_ENV === "production";
const number = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
};

const anthropicKey = (env.ANTHROPIC_API_KEY ?? "").trim() !== "";
const demo = env.LLM_DEMO === "1" || env.REPLAY_LLM === "1" || args.replay === true;
const accessCode = (env.ACCESS_CODE ?? "").trim() || undefined;
// The container user can't write to /app, so production caches go to /tmp.
const cacheDir = env.CACHE_DIR ?? (production ? join(tmpdir(), "canonverge-cache") : ".cache");

if (anthropicKey && !accessCode && production) {
  console.warn("ANTHROPIC_API_KEY is set without ACCESS_CODE: anyone can trigger paid LLM runs (up to LLM_DAILY_CAP).");
}

const app = createApp({
  env: { anthropicKey, githubToken: resolveToken() !== undefined },
  extractor: anthropicKey ? createClaudeExtractor() : undefined,
  demoExtractor: demo
    ? await createReplayExtractor("fixtures/resume-llm-responses.json", "fixtures/resumes")
    : undefined,
  accessCode,
  runsPerHour: number(env.RATE_LIMIT_PER_HOUR, 0),
  llmDailyCap: number(env.LLM_DAILY_CAP, 200),
  llmMaxResumes: number(env.LLM_MAX_RESUMES, 10),
  trustedProxyHops: number(env.TRUSTED_PROXY_HOPS, 0),
  githubCache: new FileResponseCache(join(cacheDir, "github")),
  llmCache: new FileLlmCache(join(cacheDir, "llm")),
  log: (line) => console.log(JSON.stringify({ time: new Date().toISOString(), ...line })),
});

// src/server/main.ts and dist/server/main.js both sit two levels below the repo root.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  serveApp(app, webDist);
} else {
  console.warn("web/dist not found: serving the API only. Run `npm run build` for the pages.");
}

const port = Number(typeof args.port === "string" ? args.port : (env.PORT ?? 8787));
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `CanonVerge listening on http://localhost:${info.port} (LLM: ${anthropicKey ? (accessCode ? "access code" : "open") : "off"}${demo ? ", demo on" : ""})`,
  );
});

// Render sends SIGTERM on every deploy: stop taking new requests, let running
// runs finish their stream, and give up after 20 s.
const shutdown = () => {
  console.log("shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 20_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
