import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runPipeline, STAGES, type PipelineEvent } from "../src/pipeline.js";
import { DEFAULT_CONFIG } from "../src/schemas/config.js";

const CSV = "fixtures/recruiter-with-resumes.csv";

describe("runPipeline progress events", () => {
  it("reports every stage start and end in order, plus each source and warning", async () => {
    const events: PipelineEvent[] = [];
    const result = await runPipeline({
      csvPath: CSV,
      config: DEFAULT_CONFIG,
      asOf: "2026-11",
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);

    const stages = events
      .filter((event) => event.type === "stage")
      .map((event) => `${event.stage}:${event.status}`);
    expect(stages).toEqual(STAGES.flatMap((name) => [`${name}:start`, `${name}:done`]));

    const sources = events.filter((event) => event.type === "source");
    expect(sources).toHaveLength(5);
    expect(sources).toContainEqual({
      type: "source",
      source: "resume",
      subject: "resumes/ravi-kumar.pdf",
      ok: false,
    });

    const warnings = events.filter((event) => event.type === "warning");
    expect(warnings).toHaveLength(1);
    // Sources and warnings all arrive before ingest is done.
    const ingestDone = events.findIndex(
      (event) => event.type === "stage" && event.stage === "ingest" && event.status === "done",
    );
    const lastNonStage = events.map((event) => event.type).lastIndexOf("source");
    expect(lastNonStage).toBeLessThan(ingestDone);
    expect(events.map((event) => event.type).lastIndexOf("warning")).toBeLessThan(ingestDone);
  });

  it("does not report events or details unless asked", async () => {
    const result = await runPipeline({ csvPath: CSV, config: DEFAULT_CONFIG, asOf: "2026-11" });
    expect(result.ok && result.details).toBeUndefined();
  });
});

describe("resolveResumePath", () => {
  // What the web server does: only files that were uploaded, matched by name.
  const uploaded = new Map([["ananya-iyer.pdf", resolve("fixtures/resumes/ananya-iyer.pdf")]]);
  const byUploadedName = (shownAs: string) => uploaded.get(basename(shownAs));

  it("reads only files the resolver returns, and warns for the rest", async () => {
    const result = await runPipeline({
      csvPath: CSV,
      config: DEFAULT_CONFIG,
      asOf: "2026-11",
      resolveResumePath: byUploadedName,
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.stats.resumes).toBe(5);
    expect(result.warnings.map((w) => [w.subject, w.message])).toEqual([
      ["resumes/daniel-okafor.pdf", "no uploaded file has this name."],
      ["resumes/kenji-watanabe.txt", "no uploaded file has this name."],
      ["resumes/ravi-kumar.pdf", "no uploaded file has this name."],
      ["resumes/sofia-marin.docx", "no uploaded file has this name."],
    ]);
  });

  it("never follows a path that tries to leave the upload folder", async () => {
    const seen: string[] = [];
    const result = await runPipeline({
      csvPath: CSV,
      config: DEFAULT_CONFIG,
      asOf: "2026-11",
      resolveResumePath: (shownAs) => {
        seen.push(shownAs);
        return byUploadedName(shownAs.replace("resumes/", "../../../../"));
      },
    });
    if (!result.ok) throw new Error(result.error);
    // Basename matching turns "../../../../ananya-iyer.pdf" into the uploaded file only.
    expect(seen).toHaveLength(5);
    expect(result.stats.resumesWithWarnings).toBe(4);
  });
});

describe("includeFieldConfidence", () => {
  it("returns per-field confidences beside the records, in the same order", async () => {
    const result = await runPipeline({
      csvPath: CSV,
      config: DEFAULT_CONFIG,
      asOf: "2026-11",
      includeFieldConfidence: true,
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.details).toHaveLength(result.records.length);
    const first = result.records[0] as { candidate_id: string };
    expect(result.details?.[0]).toEqual({
      candidate_id: first.candidate_id,
      fieldConfidence: {
        full_name: 0.9,
        "links.portfolio": 0.8,
        "links.linkedin": 0.8,
        emails: 1,
        phones: 1,
        experience: 0.9,
      },
    });
  });
});
