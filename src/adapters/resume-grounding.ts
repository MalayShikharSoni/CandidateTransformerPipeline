/**
 * The grounding check: the line between "the LLM read this from the resume"
 * and "the LLM made this up". It is plain string matching, so it is
 * deterministic and easy to audit.
 *
 * An item the model returned is kept only if:
 *  1. every value in it (company, title, dates, school, skill name...) appears
 *     word for word in the resume text, and
 *  2. all of an entry's values sit close together in the text, so a title from
 *     one job can't be paired with the dates of another.
 *
 * Comparison ignores case, runs of whitespace, and the dash and quote
 * variants that PDF text extraction produces.
 */

/** How far apart (in characters of resume text) one entry's values may be. */
export const ENTRY_WINDOW = 600;

export function canon(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Start offsets of every whole-word occurrence of `needle` in `haystack` (both canon'd). */
function occurrences(haystack: string, needle: string): number[] {
  if (needle === "") {
    return [];
  }
  // Whole words only, so the skill "Go" is not found inside "Google".
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}(?![a-z0-9])`, "g");
  return [...haystack.matchAll(pattern)].map((match) => match.index);
}

export class ResumeText {
  readonly canonical: string;

  constructor(text: string) {
    this.canonical = canon(text);
  }

  /** true when `value` appears word for word in the resume. */
  contains(value: string): boolean {
    return occurrences(this.canonical, canon(value)).length > 0;
  }

  /**
   * true when every value appears in the resume and some occurrence of each
   * lies within ENTRY_WINDOW characters of an occurrence of the first (the
   * anchor, e.g. the company name).
   */
  containsNearby(values: string[]): boolean {
    const [anchor, ...rest] = values.map(canon);
    if (anchor === undefined) {
      return false;
    }
    const anchorPositions = occurrences(this.canonical, anchor);
    const restPositions = rest.map((value) => occurrences(this.canonical, value));
    if (anchorPositions.length === 0 || restPositions.some((list) => list.length === 0)) {
      return false;
    }
    return anchorPositions.some((anchorAt) =>
      restPositions.every((positions) =>
        positions.some((at) => Math.abs(at - anchorAt) <= ENTRY_WINDOW),
      ),
    );
  }
}
