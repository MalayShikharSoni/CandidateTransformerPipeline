# PROJECT CONTEXT — Multi-Source Candidate Data Transformer

Read this fully before writing any code. This document is the source of truth for
architecture and scope decisions. Do not deviate from it without explicitly flagging
the deviation and asking first.

## What this is

A CLI tool that ingests candidate data from two sources, merges it into one canonical
profile per candidate, and projects it into a configurable output shape. Full spec
lives in `docs/problem-statement.md`. Design rationale lives in `docs/design-doc.md`
(also `docs/design-doc.pdf`), which reflects already-finalized decisions; this file
operationalizes it for implementation.

## Stack (fixed — do not suggest alternatives)

- Node.js + TypeScript only. No Python, no second language, no exceptions.
- Libraries: `zod` (schema validation), `vitest` (testing), `csv-parse` (CSV),
  `libphonenumber-js` (phone normalization), native `fetch` (GitHub API calls — no axios needed).
- No frameworks. No Express/Nest (this is a CLI, not a server). No LangChain,
  no Hugging Face, no LLM calls anywhere in the pipeline. No ORM, no database —
  everything is in-memory for the scope of a CLI run.
- Package manager: npm.

## Sources (fixed — exactly these two, nothing more for the primary build)

1. **Recruiter CSV** (structured) — columns: name, email, phone, current_company, title.
2. **GitHub profile** (unstructured, via REST API: `https://api.github.com/users/{username}`) —
   fields used: name, bio, html_url, login, public repo languages (for weak skill signal).

Do NOT implement LinkedIn, resume parsing, or ATS JSON unless explicitly asked later.
These are documented as descoped in the design doc.

## Pipeline (fixed stage order — do not reorder or merge stages)

```
ingest -> extract -> normalize -> merge -> confidence -> project -> validate -> emit
```

Each stage is a pure function (or close to it) operating on well-typed inputs/outputs.
No stage should reach into another stage's internals.

- **ingest**: read CSV file from disk, call GitHub REST API. Wrap each in try/catch.
  A missing/empty/malformed source produces an empty result for that source — never throws
  up to the caller.
- **extract**: map each source's native shape to `RawFact[]`:
  `{ field: string, rawValue: unknown, source: 'csv' | 'github', sourceMethod: string }`.
- **normalize**: pure per-field functions. phone -> E.164. dates -> `YYYY-MM`.
  country -> ISO-3166 alpha-2. skills -> canonical name via a static synonym map
  (e.g. "js"/"javascript"/"java script" -> "JavaScript"). A normalizer that cannot
  parse input returns `null`. Never throws, never invents a value.
- **merge**: group RawFacts by match key. Match key priority: `email` first; if
  email is absent on both sides, fall back to `name + company` (normalized,
  case-insensitive). If no shared key exists at all, treat as separate candidate
  records — do NOT attempt fuzzy/probabilistic matching.
  `candidate_id = sha256(matchKey)`.
  Per-field resolution: structured source (CSV) wins IF AND ONLY IF its value is
  non-null AND passed normalization. Otherwise fall through to the next source in
  precedence order. If two sources have valid, differing values, the higher-precedence
  one wins but the conflict is recorded in provenance as
  `method: "precedence_override_conflict"`.
- **confidence**: per-field score, computed independently of which value won.
  Concrete weights: CSV base 0.9, GitHub-derived base 0.6. +0.1 if a second source
  agrees on the same value. ×0.5 multiplier if normalization failed for that fact.
  Clamp to [0, 1]. `overall_confidence` = average of populated field confidences.
- **project**: apply the runtime config to the canonical record. Config shape:
  `{ fields: [{ path, from, type, required?, normalize? }], include_confidence: bool,
  on_missing: 'null' | 'omit' | 'error' }`. This stage NEVER mutates the canonical
  record — it reads from it and produces a new shaped output. Must support a `[]`
  segment in `from` paths (e.g. `"skills[].name"`) that maps the rule over every
  array element — this is the trickiest part of the assignment, build and test it
  carefully, don't rush it.
- **validate**: Zod schema check on the *projected* output before returning. Respect
  `on_missing` per field. Catch and attribute failures per-candidate in batch runs —
  one bad record must never abort the whole run.

## Canonical schema (fixed field list)

```
candidate_id: string
full_name: string
emails: string[]
phones: string[]              // E.164
location: { city, region, country }   // country = ISO-3166 alpha-2
links: { linkedin, github, portfolio, other: string[] }
headline: string | null
years_experience: number | null   // ALWAYS null with CSV+GitHub — document this, don't fabricate
skills: { name, confidence, sources: string[] }[]
experience: { company, title, start, end, summary }[]   // dates as YYYY-MM
education: []              // ALWAYS empty with CSV+GitHub — document this, don't fabricate
provenance: { field, source, method }[]
overall_confidence: number
```

## Things explicitly rejected — do not reintroduce these

- No LLM/agent-based extraction or matching anywhere. This was a deliberate decision,
  not an oversight. If you (the AI assistant) think an LLM call would help with skill
  extraction, name matching, or anything else — don't. Flag it in conversation instead.
- No fuzzy/probabilistic entity resolution. Deterministic matching only.
- No premature abstraction: no plugin/adapter registry system for hypothetical future
  sources, no formal dependency injection framework, no microservice-style separation.
  Keep it to clean, well-typed functions and modules. This is a focused CLI tool for
  a take-home assignment, not a production platform — over-engineering is a real risk
  here and should be actively avoided.
- No double-validation passes (validate-before-merge AND validate-before-output) —
  single validation pass on the final projected output is sufficient and was a
  deliberate scope decision.

## Testing (5 tests, mapped to design-doc edge cases — not more, not fewer by default)

1. Missing source entirely (GitHub 404 / blank URL) — pipeline continues, doesn't crash.
2. Conflicting non-null values across sources — resolved by precedence, conflict flagged.
3. Malformed structured data (bad CSV phone) — normalizer returns null, not a crash/fabrication.
4. Sparse unstructured source (GitHub profile with no bio/repos/links) — only real fields populate.
5. Custom config requests an unreachable field with `on_missing: "error"` — fails explicitly with a reason.

Use `vitest`. Keep tests short and readable — each one should be obviously mappable
back to the edge case it tests, since these will be discussed in the demo video.

## CLI surface (lower priority — keep this thin)

A simple CLI: point it at the CSV path + a GitHub username (or list, for batch),
optionally a config JSON path, and it prints/writes the resulting JSON. Do not spend
time on polish here — flags, help text, and colored output are not graded. A clean,
documented `npm run start -- --csv path --github username` is sufficient.

## What "done" looks like

- Runs end-to-end on sample inputs, producing schema-valid JSON for the default schema
  AND at least one custom config.
- Handles both source types correctly, with normalization and merge working as specified.
- All 5 tests pass.
- README documents exact run steps, assumptions, and descoped items.
- Everything in this file and the design doc PDF must be something the author (not the
  AI tool) can explain without hesitation — that is the actual grading bar.
