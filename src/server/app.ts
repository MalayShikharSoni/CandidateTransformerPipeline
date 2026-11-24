import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { executeRun, LIMITS, parseRunInput, type RunDeps } from "./run.js";

/**
 * The web API. A thin, stateless wrapper around runPipeline: no database, no
 * sessions, nothing kept after a run. Built as a factory with injected
 * dependencies so tests run it with app.request() and never touch the network.
 */

export interface AppDeps extends RunDeps {
  /** Which credentials the server has. Only presence is ever reported. */
  env: { anthropicKey: boolean; githubToken: boolean };
  /** "replay" when answers come from saved fixtures (dev only). */
  llmMode?: "claude" | "replay" | "off";
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      llmAvailable: deps.env.anthropicKey && deps.extractor !== undefined,
      llmMode: deps.extractor === undefined ? "off" : (deps.llmMode ?? "claude"),
      githubToken: deps.env.githubToken,
      limits: LIMITS,
    }),
  );

  app.post(
    "/api/runs",
    bodyLimit({
      maxSize: LIMITS.bodyBytes,
      onError: (c) => c.json({ error: "The upload is larger than 50 MB." }, 413),
    }),
    async (c) => {
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

      return streamSSE(c, async (stream) => {
        await executeRun(parsed.input, deps, (event) =>
          stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) }),
        );
      });
    },
  );

  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.text("Not found.", 404),
  );

  return app;
}
