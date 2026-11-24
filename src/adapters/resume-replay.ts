import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readResumeText } from "./resume.js";
import { ResumeExtraction, type ResumeExtractor } from "./resume-llm.js";

/**
 * An extractor that never calls a model: it plays back saved answers from a
 * responses file (fixtures/resume-llm-responses.json), matched by the resume's
 * text. Used by tests, and by the web server in dev (REPLAY_LLM=1) to demo LLM
 * runs without an API key. A resume with no saved answer gets a warning.
 */
export async function createReplayExtractor(
  responsesPath: string,
  resumeDir: string,
): Promise<ResumeExtractor> {
  const saved = JSON.parse(await readFile(responsesPath, "utf8")) as {
    responses: Record<string, { model?: string; output: unknown }>;
  };
  const byText = new Map<string, { model: string; output: ResumeExtraction }>();
  for (const [file, entry] of Object.entries(saved.responses)) {
    const read = await readResumeText(join(resumeDir, file));
    const parsed = ResumeExtraction.safeParse(entry.output);
    if ("text" in read && parsed.success) {
      byText.set(read.text, { model: entry.model ?? "replay", output: parsed.data });
    }
  }

  return {
    model: "replay",
    extract(text) {
      const hit = byText.get(text);
      return Promise.resolve(
        hit === undefined
          ? { ok: false, reason: "replay mode: no saved answer for this resume." }
          : { ok: true, model: hit.model, output: hit.output },
      );
    },
  };
}
