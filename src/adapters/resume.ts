import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { findPhoneNumbersInText } from "libphonenumber-js";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { DEFAULT_PHONE_COUNTRY } from "../normalizers/phone.js";
import type { RawFact } from "../schemas/raw-fact.js";
import type { LlmCache } from "./llm-cache.js";
import { readLlmFacts, type ResumeExtractor } from "./resume-llm.js";
import type { SourceWarning } from "./warnings.js";

/**
 * Resume source. Two kinds of facts come out of one file:
 * - regex facts for values with a fixed format (email, phone, profile URLs),
 *   always on, no network;
 * - LLM facts for values that depend on layout (jobs, degrees, headline,
 *   skills), only when an extractor is passed in (the --llm flag). See resume-llm.ts.
 * Like GitHub, a missing or unreadable resume never throws: it adds zero facts
 * and a warning.
 */

export interface ResumeAdapterResult {
  facts: RawFact[];
  warnings: SourceWarning[];
  llmCalled: boolean;
  llmCacheHit: boolean;
  /** LLM items or values removed by the grounding check. */
  droppedValues: number;
}

export interface ReadResumeFactsOptions {
  /** The CSV row this resume was named in. */
  rowIndex: number;
  /** Shown in warnings; defaults to the path. */
  subject?: string;
  extract?: ResumeExtractor;
  cache?: LlmCache;
}

const SUPPORTED = [".pdf", ".docx", ".txt", ".md"];

export async function readResumeText(
  path: string,
): Promise<{ text: string } | { error: string }> {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED.includes(extension)) {
    return {
      error: `unsupported resume type "${extension || "(none)"}" (use ${SUPPORTED.join(", ")}).`,
    };
  }

  let text: string;
  try {
    if (extension === ".pdf") {
      const data = new Uint8Array(await readFile(path));
      text = (await extractText(data, { mergePages: true })).text;
    } else if (extension === ".docx") {
      text = (await mammoth.extractRawText({ path })).value;
    } else {
      text = await readFile(path, "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `cannot read resume: ${message}` };
  }

  if (text.trim() === "") {
    return { error: "resume has no extractable text (a scanned PDF needs OCR first)." };
  }
  return { text };
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([a-z0-9_-]+)/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"']+/gi;
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/** Facts for values with a fixed format. Deterministic; nothing leaves the machine. */
export function regexFacts(text: string, rowIndex: number): RawFact[] {
  const facts: RawFact[] = [];
  const add = (field: string, rawValue: string, method: string) => {
    facts.push({
      field,
      rawValue,
      source: "resume",
      sourceMethod: `resume_regex:${method}`,
      rowIndex,
      rowLinked: true,
    });
  };

  const emails = new Set<string>();
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0].toLowerCase();
    if (!emails.has(email)) {
      emails.add(email);
      add("emails", match[0], "email");
    }
  }

  const phones = new Set<string>();
  for (const found of findPhoneNumbersInText(text, DEFAULT_PHONE_COUNTRY)) {
    const raw = text.slice(found.startsAt, found.endsAt);
    // A date range like "06/2020 – 08/2020" can parse as a valid number, so
    // only accept matches written like a phone: digits, spaces, + ( ) . -
    // and at least 10 digits.
    if (!PHONE_SHAPE.test(raw) || raw.replace(/\D/g, "").length < 10) {
      continue;
    }
    if (!phones.has(found.number.number)) {
      phones.add(found.number.number);
      add("phones", raw, "phone");
    }
  }

  const linkedin = text.match(LINKEDIN);
  if (linkedin) {
    add("links.linkedin", `https://www.linkedin.com/in/${linkedin[1]}`, "linkedin_url");
  }

  const github = text.match(GITHUB);
  if (github) {
    add("links.github", `https://github.com/${github[1]}`, "github_url");
  }

  // The first other link is taken as the portfolio.
  for (const match of text.matchAll(URL)) {
    const url = stripTrailingPunctuation(match[0]);
    if (/linkedin\.com|github\.com/i.test(url)) {
      continue;
    }
    add("links.portfolio", url.startsWith("www.") ? `https://${url}` : url, "url");
    break;
  }

  return facts;
}

export async function readResumeFacts(
  path: string,
  options: ReadResumeFactsOptions,
): Promise<ResumeAdapterResult> {
  const subject = options.subject ?? path;
  const empty: ResumeAdapterResult = {
    facts: [],
    warnings: [],
    llmCalled: false,
    llmCacheHit: false,
    droppedValues: 0,
  };

  const read = await readResumeText(path);
  if ("error" in read) {
    return { ...empty, warnings: [{ source: "resume", subject, message: read.error }] };
  }

  const facts = regexFacts(read.text, options.rowIndex);
  if (options.extract === undefined) {
    return { ...empty, facts };
  }

  const llm = await readLlmFacts(read.text, {
    rowIndex: options.rowIndex,
    extract: options.extract,
    cache: options.cache,
  });

  return {
    facts: [...facts, ...llm.facts],
    warnings: llm.warning === undefined ? [] : [{ source: "resume", subject, message: llm.warning }],
    llmCalled: llm.called,
    llmCacheHit: llm.cacheHit,
    droppedValues: llm.droppedValues,
  };
}
