import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import type { ResumeExtractor } from "../adapters/resume-llm.js";
import { accessCodeMatches, clientIp, DailyBudget, formatWait, RateLimiter, type Clock } from "./limits.js";
import { executeRun, LIMITS, parseRunInput, type LlmPlan, type RunDeps, type RunSummary } from "./run.js";

/**
 * The web API. A thin, stateless wrapper around runPipeline: no database, no
 * sessions, nothing kept after a run. Built as a factory with injected
 * dependencies so tests run it with app.request() and never touch the network.
 */

export interface AppDeps extends Omit<RunDeps, "extractor"> {
  /** Which credentials the server has. Only presence is ever reported. */
  env: { anthropicKey: boolean; githubToken: boolean };
  /** The real model (Claude). Open to every run unless accessCode is set. */
  extractor?: ResumeExtractor;
  /** Replays saved answers for the sample batch; used for LLM runs without the code. */
  demoExtractor?: ResumeExtractor;
  /** When set, real LLM runs need this code in the x-access-code header. */
  accessCode?: string;
  /** Runs per client IP per hour (0 = unlimited). */
  runsPerHour?: number;
  /** Real LLM calls allowed per UTC day. */
  llmDailyCap?: number;
  /** Most resumes one real LLM run may send to the model. */
  llmMaxResumes?: number;
  /** X-Forwarded-For hops added by our own proxy (Render: 1). 0 = use the socket address. */
  trustedProxyHops?: number;
  /** One line per run, counts only. */
  log?: (line: Record<string, unknown>) => void;
  now?: Clock;
}

const DEMO_NOTE =
  "LLM demo: answers are replayed from saved stand-ins for the sample batch. Other resumes are read with regex only; enter an access code for real extraction.";

function socketIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // app.request() in tests has no socket.
    return undefined;
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(deps.runsPerHour ?? 0, 60 * 60 * 1000, now);
  const budget = new DailyBudget(deps.llmDailyCap ?? 200, now);
  const maxLlmResumes = deps.llmMaxResumes ?? 10;
  const llmAccess = deps.extractor === undefined ? "off" : deps.accessCode ? "code" : "open";

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      llmAvailable: deps.env.anthropicKey && deps.extractor !== undefined,
      llmAccess,
      llmDemo: deps.demoExtractor !== undefined,
      githubToken: deps.env.githubToken,
      limits: { ...LIMITS, llmMaxResumes: maxLlmResumes },
    }),
  );

  app.post(
    "/api/runs",
    bodyLimit({
      maxSize: LIMITS.bodyBytes,
      onError: (c) => c.json({ error: "The upload is larger than 50 MB." }, 413),
    }),
    async (c) => {
      const ip = clientIp(c.req.header("x-forwarded-for"), socketIp(c), deps.trustedProxyHops ?? 0);
      const allowed = limiter.take(ip);
      if (!allowed.ok) {
        c.header("Retry-After", String(Math.ceil(allowed.retryAfterMs / 1000)));
        return c.json(
          { error: `Too many runs from your network. Try again in ${formatWait(allowed.retryAfterMs)}.` },
          429,
        );
      }

      let body;
      try {
        body = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: "Send the files as multipart/form-data." }, 400);
      }

      const parsed = parseRunInput(body);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }
      const { input } = parsed;

      // Decide who reads the resumes' layout: Claude, the demo replay, or nobody.
      const code = (c.req.header("x-access-code") ?? "").trim();
      let plan: LlmPlan = { mode: "none", notes: [] };
      if (input.options.llm) {
        if (deps.accessCode && code !== "" && !accessCodeMatches(code, deps.accessCode)) {
          return c.json({ error: "That access code isn’t right." }, 403);
        }
        const realAllowed =
          deps.extractor !== undefined && (!deps.accessCode || (code !== "" && accessCodeMatches(code, deps.accessCode)));

        if (realAllowed && input.resumes.length > maxLlmResumes) {
          return c.json({ error: `LLM runs take at most ${maxLlmResumes} resumes at a time.` }, 400);
        }
        if (realAllowed && budget.tryTake(input.resumes.length)) {
          plan = { mode: "claude", extractor: deps.extractor, notes: [] };
        } else if (realAllowed) {
          plan = {
            mode: deps.demoExtractor ? "demo" : "none",
            extractor: deps.demoExtractor,
            notes: ["Today's LLM allowance is used up; resumes are read with regex only until 00:00 UTC."],
          };
        } else if (deps.demoExtractor) {
          plan = { mode: "demo", extractor: deps.demoExtractor, notes: [DEMO_NOTE] };
        } else {
          plan = {
            mode: "none",
            notes: ["LLM extraction is not set up on this server (no ANTHROPIC_API_KEY); resumes are read with regex only."],
          };
        }
      }

      const started = now();
      return streamSSE(c, async (stream) => {
        const summary: RunSummary = await executeRun(input, deps, plan, (event) =>
          stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) }),
        );
        deps.log?.({ event: "run", ...summary, ms: now() - started });
      });
    },
  );

  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.text("Not found.", 404),
  );

  return app;
}
