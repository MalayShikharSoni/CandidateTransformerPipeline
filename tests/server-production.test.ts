import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResumeExtractor } from "../src/adapters/resume-llm.js";
import { createReplayExtractor } from "../src/adapters/resume-replay.js";
import { createApp } from "../src/server/app.js";
import { accessCodeMatches, clientIp, DailyBudget, RateLimiter } from "../src/server/limits.js";
import { serveApp } from "../src/server/static.js";

// The public-deployment guards: access code, rate and cost limits, headers.

const RESUMES = ["ananya-iyer.pdf", "daniel-okafor.pdf", "sofia-marin.docx", "kenji-watanabe.txt"];
const noKeys = { anthropicKey: false, githubToken: false };
const withKey = { anthropicKey: true, githubToken: false };

function runForm(options: unknown, resumes = RESUMES): FormData {
  const form = new FormData();
  form.append("csv", new File([readFileSync("fixtures/recruiter-with-resumes.csv")], "batch.csv"));
  for (const name of resumes) form.append("resumes", new File([readFileSync(`fixtures/resumes/${name}`)], name));
  form.append("options", JSON.stringify(options));
  return form;
}

interface Sse {
  event: string;
  data: unknown;
}

async function readSse(response: Response): Promise<Sse[]> {
  return (await response.text())
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}

function llmModeOf(events: Sse[]): string {
  return (events.find((e) => e.event === "result")?.data as { llmMode: string }).llmMode;
}

function notesOf(events: Sse[]): string[] {
  return events.filter((e) => e.event === "log").map((e) => (e.data as { text: string }).text);
}

/** A stand-in for Claude that records what it was asked to read. */
function fakeClaude() {
  const calls: string[] = [];
  const extractor: ResumeExtractor = {
    model: "fake-claude",
    async extract(text) {
      calls.push(text);
      return { ok: true, model: "fake-claude", output: { headline: null, skills: [], experience: [], education: [] } };
    },
  };
  return { extractor, calls };
}

function demo() {
  return createReplayExtractor("fixtures/resume-llm-responses.json", "fixtures/resumes");
}

describe("LLM access code", () => {
  async function codeApp() {
    const claude = fakeClaude();
    const app = createApp({ env: withKey, extractor: claude.extractor, demoExtractor: await demo(), accessCode: "open sesame" });
    return { app, claude };
  }

  it("reports that real LLM runs need a code and that the demo is on, without leaking the code", async () => {
    const { app } = await codeApp();
    const body = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ llmAccess: "code", llmDemo: true });
    expect(JSON.stringify(body)).not.toContain("open sesame");
  });

  it("runs the demo replay without a code, never calling Claude", async () => {
    const { app, claude } = await codeApp();
    const events = await readSse(await app.request("/api/runs", { method: "POST", body: runForm({ llm: true }) }));
    expect(llmModeOf(events)).toBe("demo");
    expect(claude.calls).toHaveLength(0);
    expect(notesOf(events).some((note) => note.startsWith("LLM demo"))).toBe(true);
  });

  it("refuses a wrong code with 403", async () => {
    const { app, claude } = await codeApp();
    const response = await app.request("/api/runs", {
      method: "POST",
      body: runForm({ llm: true }),
      headers: { "x-access-code": "guess" },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("That access code isn’t right.");
    expect(claude.calls).toHaveLength(0);
  });

  it("uses Claude with the right code (surrounding spaces ignored)", async () => {
    const { app, claude } = await codeApp();
    const events = await readSse(
      await app.request("/api/runs", {
        method: "POST",
        body: runForm({ llm: true }),
        headers: { "x-access-code": "  open sesame " },
      }),
    );
    expect(llmModeOf(events)).toBe("claude");
    expect(claude.calls).toHaveLength(4);
  });

  it("ignores the code when the LLM toggle is off", async () => {
    const { app, claude } = await codeApp();
    const events = await readSse(
      await app.request("/api/runs", { method: "POST", body: runForm({ llm: false }), headers: { "x-access-code": "nope" } }),
    );
    expect(llmModeOf(events)).toBe("none");
    expect(claude.calls).toHaveLength(0);
  });

  it("compares codes without leaking timing on length", () => {
    expect(accessCodeMatches("open sesame", "open sesame")).toBe(true);
    expect(accessCodeMatches("open", "open sesame")).toBe(false);
    expect(accessCodeMatches("", "open sesame")).toBe(false);
  });
});

describe("cost and abuse limits", () => {
  it("rate-limits runs per client IP, trusting only our proxy's hop", async () => {
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const app = createApp({ env: noKeys, runsPerHour: 2, trustedProxyHops: 1, now: () => clock });
    const run = (forwardedFor: string) =>
      app.request("/api/runs", { method: "POST", body: runForm({}, []), headers: { "x-forwarded-for": forwardedFor } });

    expect((await run("6.6.6.6, 1.1.1.1")).status).toBe(200);
    // A client-supplied first entry can't dodge the limit: the proxy's hop (last) counts.
    expect((await run("7.7.7.7, 1.1.1.1")).status).toBe(200);
    const blocked = await run("8.8.8.8, 1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    expect(((await blocked.json()) as { error: string }).error).toBe("Too many runs from your network. Try again in 60 min.");

    expect((await run("2.2.2.2")).status).toBe(200);
    clock += 60 * 60 * 1000;
    expect((await run("1.1.1.1")).status).toBe(200);
  });

  it("falls back to the demo once the daily LLM allowance is used, and resets at midnight UTC", async () => {
    let clock = Date.parse("2026-11-25T23:00:00Z");
    const app = createApp({
      env: withKey,
      extractor: fakeClaude().extractor,
      demoExtractor: await demo(),
      llmDailyCap: 5,
      now: () => clock,
    });
    const run = async () => readSse(await app.request("/api/runs", { method: "POST", body: runForm({ llm: true }) }));

    expect(llmModeOf(await run())).toBe("claude");
    const second = await run();
    expect(llmModeOf(second)).toBe("demo");
    expect(notesOf(second).some((note) => note.includes("allowance is used up"))).toBe(true);

    clock += 2 * 60 * 60 * 1000;
    expect(llmModeOf(await run())).toBe("claude");
  });

  it("caps how many resumes one real LLM run may send", async () => {
    const app = createApp({ env: withKey, extractor: fakeClaude().extractor, llmMaxResumes: 3 });
    const response = await app.request("/api/runs", { method: "POST", body: runForm({ llm: true }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("LLM runs take at most 3 resumes at a time.");
  });

  it("logs one line per run with counts only", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const app = createApp({ env: noKeys, log: (line) => lines.push(line) });
    await (await app.request("/api/runs", { method: "POST", body: runForm({}) })).text();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "run", status: "ok", rows: 5, resumes: 4, candidates: 5, llm: "none" });
    expect(JSON.stringify(lines[0])).not.toMatch(/Ananya|@example|\.pdf/);
  });

  it("RateLimiter, DailyBudget and clientIp behave at their edges", () => {
    expect(new RateLimiter(0, 1000).take("x")).toEqual({ ok: true });
    const budget = new DailyBudget(3, () => 0);
    expect(budget.tryTake(4)).toBe(false);
    expect(budget.remaining()).toBe(3);
    expect(budget.tryTake(3)).toBe(true);
    expect(budget.remaining()).toBe(0);
    expect(clientIp(undefined, "9.9.9.9", 1)).toBe("9.9.9.9");
    expect(clientIp("1.1.1.1", "9.9.9.9", 0)).toBe("9.9.9.9");
    expect(clientIp("1.1.1.1", undefined, 3)).toBe("1.1.1.1");
    expect(clientIp(undefined, undefined, 0)).toBe("unknown");
  });
});

describe("headers", () => {
  it("sends a strict content security policy and anti-sniffing headers", async () => {
    const app = createApp({ env: noKeys });
    const response = await app.request("/api/health");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("caches hashed assets for a year and always revalidates index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webdist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
    const app = createApp({ env: noKeys });
    serveApp(app, dir);

    const asset = await app.request("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const page = await app.request("/profiles/some-id");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(await page.text()).toContain('id="root"');

    expect((await app.request("/api/missing")).status).toBe(404);
  });
});
