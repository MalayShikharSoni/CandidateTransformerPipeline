import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLlmCache, llmCacheKey, MemoryLlmCache } from "../src/adapters/llm-cache.js";
import { readResumeFacts, readResumeText, regexFacts } from "../src/adapters/resume.js";
import {
  PROMPT_VERSION,
  type ResumeExtraction,
  type ResumeExtractor,
} from "../src/adapters/resume-llm.js";

const ANSWER: ResumeExtraction = {
  headline: "Site Reliability Engineer",
  skills: ["Linux"],
  experience: [{ company: "Adventure Works", title: "Site Reliability Engineer", start: "2019", end: "2024" }],
  education: [],
};

function fakeExtractor(answer: ResumeExtraction | { fail: string }) {
  const calls: string[] = [];
  const extractor: ResumeExtractor = {
    model: "fake-model",
    async extract(text) {
      calls.push(text);
      return "fail" in answer
        ? { ok: false, reason: answer.fail }
        : { ok: true, model: "fake-model", output: answer };
    },
  };
  return { extractor, calls };
}

function tempFile(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "resume-")), name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("readResumeText", () => {
  it("reads a one-column PDF", async () => {
    const read = await readResumeText("fixtures/resumes/ananya-iyer.pdf");
    expect("text" in read && read.text).toContain("Senior Backend Engineer, Northwind Labs");
  });

  it("reads a two-column PDF, whose columns come out interleaved", async () => {
    const read = await readResumeText("fixtures/resumes/daniel-okafor.pdf");
    expect("text" in read && read.text).toContain("Fabrikam Health");
    expect("text" in read && read.text).toContain("Python");
  });

  it("reads DOCX, TXT and Markdown", async () => {
    for (const [file, expected] of [
      ["sofia-marin.docx", "Woodgrove Bank"],
      ["kenji-watanabe.txt", "Adventure Works"],
      ["priya-desai.md", "Margie's Travel"],
    ]) {
      const read = await readResumeText(`fixtures/resumes/${file}`);
      expect("text" in read && read.text).toContain(expected);
    }
  });

  it("reports an unsupported type, a missing file and an empty file", async () => {
    expect(await readResumeText("cv.rtf")).toEqual({
      error: 'unsupported resume type ".rtf" (use .pdf, .docx, .txt, .md).',
    });
    expect(await readResumeText("fixtures/resumes/nobody.pdf")).toMatchObject({
      error: expect.stringContaining("cannot read resume") as string,
    });
    expect(await readResumeText(tempFile("blank.txt", "  \n"))).toEqual({
      error: "resume has no extractable text (a scanned PDF needs OCR first).",
    });
  });
});

describe("regexFacts", () => {
  it("finds emails, phones and profile links, tagged as row-linked resume facts", () => {
    const facts = regexFacts(
      [
        "Jane Roe  JANE@example.com  jane@example.com",
        "+91 98765 43101",
        "Worked 06/2020 – 08/2020 and 2018 – 05/2020",
        "linkedin.com/in/jane-roe | github.com/janeroe/some-repo | www.janeroe.example.dev.",
      ].join("\n"),
      2,
    );

    expect(facts.map((fact) => [fact.field, fact.rawValue])).toEqual([
      ["emails", "JANE@example.com"],
      ["phones", "+91 98765 43101"],
      ["links.linkedin", "https://www.linkedin.com/in/jane-roe"],
      ["links.github", "https://github.com/janeroe"],
      ["links.portfolio", "https://www.janeroe.example.dev"],
    ]);
    expect(facts.every((fact) => fact.source === "resume" && fact.rowLinked === true)).toBe(true);
    expect(facts[0].sourceMethod).toBe("resume_regex:email");
  });

  it("returns nothing for text without contact details", () => {
    expect(regexFacts("Just a paragraph about gardening.", 0)).toEqual([]);
  });
});

describe("readResumeFacts", () => {
  const path = "fixtures/resumes/kenji-watanabe.txt";

  it("without an extractor gives only regex facts and never calls the LLM", async () => {
    const result = await readResumeFacts(path, { rowIndex: 0 });
    expect(result.facts.every((fact) => fact.sourceMethod.startsWith("resume_regex:"))).toBe(true);
    expect(result).toMatchObject({ warnings: [], llmCalled: false, llmCacheHit: false });
  });

  it("adds grounded LLM facts when an extractor is given", async () => {
    const { extractor } = fakeExtractor(ANSWER);
    const result = await readResumeFacts(path, { rowIndex: 4, extract: extractor });
    const llmFields = result.facts
      .filter((fact) => fact.sourceMethod.startsWith("resume_llm:"))
      .map((fact) => fact.field);
    expect(llmFields).toEqual(["headline", "skills", "experience.entry"]);
    expect(result.llmCalled).toBe(true);
  });

  it("keeps the regex facts and warns when the LLM call fails", async () => {
    const { extractor } = fakeExtractor({ fail: "Anthropic rate limit reached (HTTP 429)." });
    const result = await readResumeFacts(path, { rowIndex: 0, subject: "kenji.txt", extract: extractor });
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([
      { source: "resume", subject: "kenji.txt", message: "Anthropic rate limit reached (HTTP 429)." },
    ]);
  });

  it("warns and adds nothing when the file can't be read", async () => {
    const result = await readResumeFacts("fixtures/resumes/missing.pdf", { rowIndex: 0 });
    expect(result.facts).toEqual([]);
    expect(result.warnings[0]).toMatchObject({ source: "resume", subject: "fixtures/resumes/missing.pdf" });
  });

  it("replays a cached answer instead of calling the LLM again", async () => {
    const cache = new MemoryLlmCache();
    const { extractor, calls } = fakeExtractor(ANSWER);

    const first = await readResumeFacts(path, { rowIndex: 0, extract: extractor, cache });
    const second = await readResumeFacts(path, { rowIndex: 0, extract: extractor, cache });

    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ llmCalled: false, llmCacheHit: true });
    expect(second.facts).toEqual(first.facts);
  });

  it("ignores a cached answer that no longer fits the schema", async () => {
    const cache = new MemoryLlmCache();
    const { extractor, calls } = fakeExtractor(ANSWER);
    const read = await readResumeText(path);
    const text = "text" in read ? read.text : "";
    await cache.set(llmCacheKey({ model: "fake-model", promptVersion: PROMPT_VERSION, text }), {
      model: "fake-model",
      output: { skills: "not a list" },
    });

    await readResumeFacts(path, { rowIndex: 0, extract: extractor, cache });
    expect(calls).toHaveLength(1);
  });
});

describe("FileLlmCache", () => {
  it("stores and reads back an answer, and treats a corrupt file as a miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-cache-"));
    const cache = new FileLlmCache(dir);
    const key = llmCacheKey({ model: "m", promptVersion: "v", text: "t" });

    expect(await cache.get(key)).toBeUndefined();
    await cache.set(key, { model: "m", output: { a: 1 } });
    expect(await cache.get(key)).toEqual({ model: "m", output: { a: 1 } });

    writeFileSync(join(dir, `${key}.json`), "{not json", "utf8");
    expect(await cache.get(key)).toBeUndefined();
  });

  it("changes the key when the prompt version or model changes", () => {
    const base = { model: "m", promptVersion: "v1", text: "t" };
    expect(llmCacheKey(base)).not.toBe(llmCacheKey({ ...base, promptVersion: "v2" }));
    expect(llmCacheKey(base)).not.toBe(llmCacheKey({ ...base, model: "m2" }));
  });
});
