import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryLlmCache } from "../src/adapters/llm-cache.js";
import type { ResumeExtractor } from "../src/adapters/resume-llm.js";
import { createReplayExtractor } from "../src/adapters/resume-replay.js";
import { createApp } from "../src/server/app.js";
import { LIMITS, parseRunInput, safeName } from "../src/server/run.js";

const RESUMES = ["ananya-iyer.pdf", "daniel-okafor.pdf", "sofia-marin.docx", "kenji-watanabe.txt"];

/** Replays fixtures/resume-llm-responses.json, matched by resume text (no API calls). */
function replayExtractor(): Promise<ResumeExtractor> {
  return createReplayExtractor("fixtures/resume-llm-responses.json", "fixtures/resumes");
}

function file(path: string, name = path.split("/").pop() ?? path): File {
  return new File([readFileSync(path)], name);
}

function runForm(options: unknown, resumes = RESUMES, csv = "fixtures/recruiter-with-resumes.csv"): FormData {
  const form = new FormData();
  form.append("csv", file(csv));
  for (const name of resumes) form.append("resumes", file(`fixtures/resumes/${name}`));
  form.append("options", JSON.stringify(options));
  return form;
}

interface Sse {
  event: string;
  data: unknown;
}

async function readSse(response: Response): Promise<Sse[]> {
  const text = await response.text();
  return text
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

const noKeys = { anthropicKey: false, githubToken: false };

describe("GET /api/health", () => {
  it("reports which features are available, never the keys themselves", async () => {
    const app = createApp({ env: { anthropicKey: true, githubToken: false }, extractor: await replayExtractor() });
    const body = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, llmAvailable: true, githubToken: false });
    expect(JSON.stringify(body)).not.toMatch(/sk-|key=/i);
  });

  it("says the LLM is unavailable without credentials", async () => {
    const app = createApp({ env: noKeys });
    const body = (await (await app.request("/api/health")).json()) as { llmAvailable: boolean };
    expect(body.llmAvailable).toBe(false);
  });
});

describe("POST /api/runs", () => {
  it("streams every stage, then the records, for a full run with the LLM", async () => {
    const app = createApp({
      env: { anthropicKey: true, githubToken: false },
      extractor: await replayExtractor(),
      llmCache: new MemoryLlmCache(),
    });
    const response = await app.request("/api/runs", {
      method: "POST",
      body: runForm({ llm: true, asOf: "2026-11" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(response);
    const stages = events
      .filter((e) => e.event === "stage")
      .map((e) => (e.data as { stage: string; status: string }).stage);
    expect(stages.slice(0, 2)).toEqual(["ingest", "ingest"]);
    expect(stages.at(-1)).toBe("emit");

    const result = events.find((e) => e.event === "result")?.data as {
      records: Array<{ full_name: string }>;
      stats: { resumeLlmCalls: number; resumes: number };
      warnings: Array<{ subject: string; message: string }>;
      details: unknown[];
      schema: string;
      llmUsed: boolean;
    };
    expect(result.records.map((r) => r.full_name)).toEqual([
      "Ananya Iyer",
      "Daniel Okafor",
      "Sofia Marín",
      "Kenji Watanabe",
      "Ravi Kumar",
    ]);
    expect(result).toMatchObject({ schema: "default", llmUsed: true });
    expect(result.stats).toMatchObject({ resumes: 5, resumeLlmCalls: 4 });
    expect(result.details).toHaveLength(5);
    expect(result.warnings).toEqual([
      { source: "resume", subject: "resumes/ravi-kumar.pdf", message: "no uploaded file has this name." },
    ]);
  });

  it("runs regex-only with a note when the LLM is asked for but not set up", async () => {
    const app = createApp({ env: noKeys });
    const events = await readSse(
      await app.request("/api/runs", { method: "POST", body: runForm({ llm: true, asOf: "2026-11" }) }),
    );
    const notes = events.filter((e) => e.event === "log").map((e) => (e.data as { text: string }).text);
    expect(notes.some((text) => text.includes("not set up on this server"))).toBe(true);
    const result = events.find((e) => e.event === "result")?.data as { llmUsed: boolean };
    expect(result.llmUsed).toBe(false);
  });

  it("uses a custom ProjectionConfig and reports it", async () => {
    const config = JSON.parse(readFileSync("fixtures/custom-config.json", "utf8")) as unknown;
    const app = createApp({ env: noKeys });
    const events = await readSse(
      await app.request("/api/runs", { method: "POST", body: runForm({ config }, []) }),
    );
    const result = events.find((e) => e.event === "result")?.data as {
      schema: string;
      records: Array<Record<string, unknown>>;
    };
    expect(result.schema).toBe("custom");
    expect(Object.keys(result.records[0])).toContain("primary_email");
  });

  it("rejects a bad request before streaming", async () => {
    const app = createApp({ env: noKeys });
    const noCsv = new FormData();
    noCsv.append("options", "{}");
    expect((await app.request("/api/runs", { method: "POST", body: noCsv })).status).toBe(400);

    const badMonth = await app.request("/api/runs", { method: "POST", body: runForm({ asOf: "2026-13" }, []) });
    expect(badMonth.status).toBe(400);
    expect(((await badMonth.json()) as { error: string }).error).toContain("2026-11");

    const badConfig = await app.request("/api/runs", {
      method: "POST",
      body: runForm({ config: { fields: "nope" } }, []),
    });
    expect(badConfig.status).toBe(400);
  });

  it("rejects an upload over the size limit with 413", async () => {
    const app = createApp({ env: noKeys });
    const response = await app.request("/api/runs", {
      method: "POST",
      body: "x".repeat(LIMITS.bodyBytes + 1),
      headers: { "content-type": "text/plain", "content-length": String(LIMITS.bodyBytes + 1) },
    });
    expect(response.status).toBe(413);
  });

  it("returns a 404 for unknown API paths", async () => {
    const app = createApp({ env: noKeys });
    expect((await app.request("/api/nope")).status).toBe(404);
  });
});

describe("upload safety", () => {
  it("keeps only a plain file name, so a CSV path can't reach other files", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\x\\CV Final.PDF")).toBe("cv_final.pdf");
    expect(safeName("resumes/ananya-iyer.pdf")).toBe("ananya-iyer.pdf");
  });

  it("refuses files that are not resumes, and too many of them", () => {
    const bad = parseRunInput({ csv: new File(["a"], "a.csv"), resumes: [new File(["x"], "run.sh")] });
    expect(bad).toEqual({ ok: false, error: '"run.sh" is not a .pdf, .docx, .txt or .md file.' });

    const many = Array.from({ length: LIMITS.resumes + 1 }, (_, i) => new File(["x"], `${i}.txt`));
    expect(parseRunInput({ csv: new File(["a"], "a.csv"), resumes: many })).toMatchObject({ ok: false });
    expect(parseRunInput({ csv: new File(["a"], "a.csv"), options: "{not json" })).toEqual({
      ok: false,
      error: "options is not valid JSON.",
    });
  });
});
