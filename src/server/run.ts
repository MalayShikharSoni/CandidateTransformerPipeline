import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { ResponseCache } from "../adapters/github-cache.js";
import type { FetchFn } from "../adapters/github.js";
import type { LlmCache } from "../adapters/llm-cache.js";
import type { ResumeExtractor } from "../adapters/resume-llm.js";
import type { SourceWarning } from "../adapters/warnings.js";
import { runPipeline, type CandidateDetail, type OutputRecord, type PipelineStats } from "../pipeline.js";
import { DEFAULT_CONFIG, ProjectionConfig } from "../schemas/config.js";

/**
 * One web run: save the uploads to a fresh temp folder, run the same
 * runPipeline the CLI uses, report progress as it happens, delete the folder.
 * Nothing about a run is kept on the server.
 */

export const LIMITS = {
  bodyBytes: 50 * 1024 * 1024,
  csvBytes: 5 * 1024 * 1024,
  resumeBytes: 10 * 1024 * 1024,
  resumes: 25,
} as const;

const RESUME_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

export interface RunDeps {
  fetch?: FetchFn;
  githubCache?: ResponseCache;
  llmCache?: LlmCache;
  /** Where temp folders go; defaults to the OS temp dir. */
  tmpRoot?: string;
}

const RunOptions = z.object({
  llm: z.boolean().default(false),
  asOf: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "asOf must be a month like 2026-11")
    .optional(),
  githubUser: z.string().trim().min(1).max(39).optional(),
  config: ProjectionConfig.optional(),
});

export interface RunInput {
  csv: File;
  resumes: File[];
  options: z.infer<typeof RunOptions>;
}

export interface RunResult {
  records: OutputRecord[];
  stats: PipelineStats;
  warnings: SourceWarning[];
  details: CandidateDetail[];
  /** "custom" when the request sent its own ProjectionConfig. */
  schema: "default" | "custom";
  asOf: string | null;
  llmUsed: boolean;
  /** Who read the resumes' layout: Claude, the demo replay, or nobody (regex only). */
  llmMode: LlmPlan["mode"];
}

/** Decided per request in app.ts (access code, daily cap, demo). */
export interface LlmPlan {
  mode: "claude" | "demo" | "none";
  extractor?: ResumeExtractor;
  /** Shown in the run log, e.g. why the LLM is off for this run. */
  notes: string[];
}

/** Counts only, for the server log: never names, emails or file names. */
export interface RunSummary {
  status: "ok" | "error";
  rows: number;
  resumes: number;
  candidates: number;
  llm: LlmPlan["mode"];
}

/** Server-sent event names and their payloads. */
export type RunEvent =
  | { event: "stage"; data: { stage: string; status: "start" | "done" } }
  | { event: "source"; data: { source: string; subject: string; ok: boolean } }
  | { event: "warning"; data: SourceWarning }
  | { event: "log"; data: { level: "info" | "note"; text: string } }
  | { event: "result"; data: RunResult }
  | { event: "error"; data: { error: string } };

type FormBody = Record<string, string | File | Array<string | File>>;

function files(value: FormBody[string] | undefined): File[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter((item): item is File => typeof item !== "string");
}

/** Only letters, digits, dot, dash and underscore survive; matching is case-insensitive. */
export function safeName(name: string): string {
  return basename(name.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]/g, "_").toLowerCase();
}

export function parseRunInput(body: FormBody): { ok: true; input: RunInput } | { ok: false; error: string } {
  const [csv] = files(body.csv);
  if (csv === undefined) {
    return { ok: false, error: "Add a recruiter CSV (field 'csv')." };
  }
  if (csv.size > LIMITS.csvBytes) {
    return { ok: false, error: "The CSV is larger than 5 MB." };
  }

  const resumes = files(body.resumes);
  if (resumes.length > LIMITS.resumes) {
    return { ok: false, error: `Upload at most ${LIMITS.resumes} resumes per run.` };
  }
  for (const resume of resumes) {
    if (!RESUME_EXTENSIONS.has(extname(resume.name).toLowerCase())) {
      return { ok: false, error: `"${resume.name}" is not a .pdf, .docx, .txt or .md file.` };
    }
    if (resume.size > LIMITS.resumeBytes) {
      return { ok: false, error: `"${resume.name}" is larger than 10 MB.` };
    }
  }

  let raw: unknown = {};
  if (typeof body.options === "string" && body.options.trim() !== "") {
    try {
      raw = JSON.parse(body.options);
    } catch {
      return { ok: false, error: "options is not valid JSON." };
    }
  }
  const options = RunOptions.safeParse(raw);
  if (!options.success) {
    return { ok: false, error: z.prettifyError(options.error) };
  }

  return { ok: true, input: { csv, resumes, options: options.data } };
}

export async function executeRun(
  input: RunInput,
  deps: RunDeps,
  plan: LlmPlan,
  send: (event: RunEvent) => Promise<void>,
): Promise<RunSummary> {
  const summary: RunSummary = {
    status: "error",
    rows: 0,
    resumes: input.resumes.length,
    candidates: 0,
    llm: plan.mode,
  };
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "canonverge-"));
  // Never show the server's temp path to the browser.
  const scrub = (text: string) => text.split(dir).join("upload");
  // Pipeline events arrive synchronously; keep the writes in order.
  let queue = Promise.resolve();
  const enqueue = (event: RunEvent) => {
    queue = queue.then(() => send(event));
  };

  try {
    const csvPath = join(dir, "input.csv");
    await writeFile(csvPath, Buffer.from(await input.csv.arrayBuffer()));

    const uploaded = new Map<string, string>();
    if (input.resumes.length > 0) {
      await mkdir(join(dir, "resumes"));
    }
    for (const resume of input.resumes) {
      const name = safeName(resume.name);
      const path = join(dir, "resumes", name);
      await writeFile(path, Buffer.from(await resume.arrayBuffer()));
      uploaded.set(name, path);
    }

    enqueue({
      event: "log",
      data: {
        level: "info",
        text: `read ${input.csv.name} and ${input.resumes.length} resume file(s)`,
      },
    });
    for (const note of plan.notes) {
      enqueue({ event: "log", data: { level: "note", text: note } });
    }

    const config = input.options.config ?? DEFAULT_CONFIG;
    const result = await runPipeline({
      csvPath,
      config,
      githubUser: input.options.githubUser,
      fetch: deps.fetch,
      cache: deps.githubCache,
      extractResume: plan.mode === "none" ? undefined : plan.extractor,
      llmCache: deps.llmCache,
      asOf: input.options.asOf,
      includeFieldConfidence: true,
      // Match the CSV's resume_path to an uploaded file by name only.
      resolveResumePath: (shownAs) => uploaded.get(safeName(shownAs)),
      onEvent: (event) => {
        if (event.type === "stage") {
          enqueue({ event: "stage", data: { stage: event.stage, status: event.status } });
        } else if (event.type === "source") {
          enqueue({ event: "source", data: { source: event.source, subject: event.subject, ok: event.ok } });
        } else {
          enqueue({
            event: "warning",
            data: { ...event.warning, message: scrub(event.warning.message) },
          });
        }
      },
    });

    if (!result.ok) {
      enqueue({ event: "error", data: { error: scrub(result.error) } });
    } else {
      enqueue({
        event: "result",
        data: {
          records: result.records,
          stats: result.stats,
          warnings: result.warnings.map((w) => ({ ...w, message: scrub(w.message) })),
          details: result.details ?? [],
          schema: input.options.config === undefined ? "default" : "custom",
          asOf: input.options.asOf ?? null,
          llmUsed: plan.mode !== "none",
          llmMode: plan.mode,
        },
      });
      summary.status = "ok";
      summary.rows = result.stats.csvRows;
      summary.candidates = result.stats.candidates;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    enqueue({ event: "error", data: { error: scrub(`run failed: ${message}`) } });
  } finally {
    await queue.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  return summary;
}
