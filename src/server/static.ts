import { relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { compress } from "hono/compress";

/**
 * Serves the built pages next to the API. Vite puts content-hashed files in
 * /assets, so those can be cached for a year; HTML must always be revalidated
 * so a deploy shows up on the next page load.
 */
export function serveApp(app: Hono, webDist: string): void {
  const root = relative(process.cwd(), webDist) || ".";
  const isApi = (path: string) => path.startsWith("/api/");
  const assets = serveStatic({ root });
  const indexPage = serveStatic({ root, path: "index.html" });
  // Compress pages and assets only: compressing the run's event stream would buffer it.
  const gzip = compress();

  // Cache headers are set once the file response exists (serveStatic builds
  // its own response, so headers set before it would be lost).
  app.get("*", async (c, next) => {
    if (isApi(c.req.path)) return next();
    await next();
    if (c.res.status !== 200) return;
    const isHtml = (c.res.headers.get("content-type") ?? "").includes("text/html");
    c.res.headers.set(
      "Cache-Control",
      isHtml ? "no-cache" : c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    );
  });
  app.get("*", (c, next) => (isApi(c.req.path) ? next() : gzip(c, next)));
  app.get("*", (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
  // Single-page app: any other page path gets index.html.
  app.get("*", (c, next) => (isApi(c.req.path) ? next() : indexPage(c, next)));
}
