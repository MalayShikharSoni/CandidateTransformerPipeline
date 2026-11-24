# Multi-Source Candidate Data Transformer — Technical Design

**Candidate:** Malay Shikhar Soni
**Stack:** Node.js + TypeScript

## Problem framing

Candidate data arrives from multiple sources with different shapes, reliability, and gaps. The goal: one deterministic, explainable pipeline producing a single canonical profile per candidate, with full visibility into where each value came from and how confident we are. Wrong-but-confident is the failure mode to design against, not missing data.

## Pipeline

`ingest -> extract -> normalize -> merge -> confidence -> project -> validate -> emit`

- **ingest** — read each source (Recruiter CSV, GitHub profile via REST API, resume files named in the CSV). A missing file, empty file, or failed API call produces zero facts for that source, never a crash.
- **extract** — map each source into `RawFact { field, rawValue, source, sourceMethod }`. Downstream *processing logic* is source-agnostic, but `source`/`sourceMethod` travel with every value — this is what builds the final `provenance` array.
- **normalize** — pure per-field functions (phone → E.164 via `libphonenumber-js`, dates → `YYYY-MM`, country → ISO-3166 alpha-2, skills → canonical name via synonym lookup). A normalizer that can't parse its input returns `null`, never a guess.
- **merge** — group facts by match key (`email`, falling back to `name + company`), resolve each field via the precedence policy below. `candidate_id = sha256(matchKey)` — deterministic and traceable like everything else.
- **confidence** — per-field score, independent of which value won: CSV base `0.9`, resume regex `0.8`, GitHub-derived `0.6`, resume LLM `0.5`; `+0.1` if a second source agrees; `×0.5` if normalization failed. Clamped `[0,1]`.
- **project** — apply runtime config (field subset, `from` renames, per-field normalize override, provenance/confidence toggles, `on_missing`) to the canonical record without mutating it. Array fields (e.g. `skills[]`) support a `[]` path segment (`"skills[].name"`) mapping the rule over every element.
- **validate** — schema-check (Zod) before emit. Missing required fields trigger the configured `on_missing` (`null`/`omit`/`error`). Failures are caught per-candidate — one bad record never aborts a batch.

## Canonical schema & formats

As specified: `candidate_id`, `full_name`, `emails[]`, `phones[]` (E.164), `location {city, region, country}` (ISO-3166 alpha-2), `links {linkedin, github, portfolio, other[]}`, `headline`, `years_experience`, `skills[{name, confidence, sources[]}]`, `experience[]` (`YYYY-MM`), `education[]`, `provenance[{field, source, method}]`, `overall_confidence`.

## Merge / conflict-resolution policy

1. Precedence per field: **structured before unstructured**: CSV, then resume, then GitHub-derived.
2. A higher-precedence source wins only if its value is non-null **and passes normalization** — a malformed CSV phone loses to a valid GitHub-derived one. This is what actually defeats "wrong but confident."
3. Conflicting valid values: higher precedence wins, but the conflict is recorded in provenance (`method: "precedence_override_conflict"`), never silently dropped.
4. **Known limitation:** `name + company` fallback can collide for distinct people (e.g. two "John Smith"s, same company). Accepted at this scope — no fuzzy resolution attempted; documented rather than silently risked.

## Scale & robustness

GitHub calls use an authenticated token (5,000 req/hr vs. 60 unauthenticated) with bounded concurrency; CSV is streamed, not fully buffered. At "thousands of candidates," per-record failures (bad row, 404 profile) are caught and logged without aborting the batch.

## Runtime custom-output config

Applied entirely in the **project** stage, after the canonical record is built. Canonical model and projection are decoupled: a new output shape needs only a new config object, no changes to ingest/normalize/merge. Output is schema-validated post-projection regardless of config.

## Edge cases handled

1. Missing source entirely (blank GitHub URL, 404) — contributes zero facts, pipeline continues.
2. Conflicting non-null values (CSV name vs. GitHub display name) — resolved by precedence, flagged in provenance.
3. Malformed structured data (invalid CSV phone) — normalizer returns `null`, never fabricates.
4. Sparse unstructured source (GitHub profile with no bio/repos/links) — contributes only what exists.
5. Custom config requests a field neither source provides, `on_missing: "error"` — fails explicitly with a reason, not a silent partial record.

## Resume source and grounded LLM extraction

Added after the first build to fill the fields CSV + GitHub can't reach: `experience[]` history with dates, `education[]`, `years_experience`, and `links.linkedin`.

**Why an LLM, and only here.** CSV and GitHub are structured, so rules handle them exactly. A resume is not: where a job title, company and dates sit depends on layout (one or two columns, headings, "Jan '21 – Present", "SDE II @ Foo"). A hand-written section parser for that is an open-ended pile of layout heuristics, which is why resume parsing is a product category of its own. That alternative was considered and rejected. Fixed-format values in the same resume (emails, phones, profile URLs) still use regex, because rules are exact there and the email is what ties records together.

**How it's contained.**
1. **One call site, opt-in.** `--llm` sends resume text to Claude (`claude-opus-5-5`, low effort, structured output against a Zod schema). Without the flag, resumes contribute only regex facts.
2. **Grounding check** (`src/adapters/resume-grounding.ts`). The model is told to copy values verbatim. Every value it returns must appear word for word in the resume text (ignoring case, spacing and dash/quote variants, whole words only), and an entry's values must sit within 600 characters of its anchor (the company or institution), so a title from one job can't be paired with another job's dates. An entry whose anchor fails is dropped; any other value that fails is set to `null`. The run summary counts what was dropped.
3. **Same pipeline afterwards.** Surviving values become ordinary `RawFact`s (`sourceMethod: resume_llm:*`) and go through the existing normalizers (dates to `YYYY-MM`, skill synonyms), merge and confidence. They get the lowest base confidence (`0.5`) and can never override a CSV value; provenance marks them `llm_extracted`.
4. **Replayable.** The model call is not deterministic, so its answer is treated like fetched data: it is cached under `sha256(model, prompt version, resume text)`. Re-runs replay it and produce byte-identical output; changing the prompt or model changes the key. Tests replay saved answers and never call the API.
5. **Fails safe.** A refusal (with a server-side fallback model first), a cut-off answer, an API error or an unreadable file becomes a warning; the resume's regex facts and every other source still go through. `--strict` turns those warnings into exit code 2.

**Merging with the CSV.** A resume job whose company exactly equals the CSV `current_company` (case and spacing aside, no fuzzy matching) is the same job: the CSV company and title win, the resume adds the dates. `years_experience` is the union of dated jobs in years (overlaps counted once); an ongoing job runs to `--as-of` (default: the current month), passed in so the output doesn't depend on the clock.

**Evaluation.** `npm run eval:resumes` scores the extraction against hand-written answer keys for ten synthetic resumes covering one- and two-column PDFs, DOCX, TXT, Markdown, year-only / numeric / two-digit dates, an undated job, overlapping jobs, a sparse resume and an injected instruction. It reports precision (how many extracted items are right) and recall per field, plus values dropped by grounding. Precision matters most: a wrong job is worse than a missing one.

**Limits.**
- Grounding proves a value is *in* the resume, not that it is *true*: a resume can state anything, including an instruction aimed at screening tools. The prompt tells the model to treat the resume as data, and one test-set resume checks that.
- Scanned PDFs have no text layer and need OCR first; they produce a warning.
- Two-digit years ("Jan '21") don't normalize; the job is kept without dates at halved confidence.
- Resume text goes to the Anthropic API under the account's data-retention terms. That is why `--llm` is opt-in and the fixtures are synthetic.

## Web UI

The web app is a second front end on the same pipeline, not a second implementation.

- **Thin, stateless server.** A Hono API (`src/server/`) saves a run's uploads to a temp folder, calls `runPipeline`, and deletes the folder. No database, sessions or auth; results stream back and stay in the browser tab.
- **Live progress without coupling.** `runPipeline` takes an optional `onEvent` callback (stage start/end, each source read, warnings). The server forwards it as server-sent events; the CLI ignores it. Confidence, project and validate run as three passes so each stage has a real start and end; output is unchanged (golden files identical).
- **No path tricks.** In the web app, a CSV's `resume_path` is matched to uploaded files by file name only (`resolveResumePath`), so a crafted CSV can't make the server read other files.
- **Per-field confidence beside the record.** The canonical schema has no slot for it, so `includeFieldConfidence` returns it next to the records for the profile page; CLI output is untouched.
- **Deployment.** Render runs `Dockerfile.web` as one long-lived Node process. Vercel was considered: its functions cap request bodies at 4.5 MB (too small for a batch of PDFs) and share no memory or disk between calls, so the caches, rate limits and daily LLM cap would need an external store. Render runs the server unchanged.
- **Cost and abuse.** Real Claude runs need an access code (compared in constant time); without it, LLM runs replay saved answers for the sample batch. Per-IP rate limits (counting only the proxy-added `X-Forwarded-For` hop), a daily Claude cap and a per-run resume cap bound the spend; logs hold counts only.
- **Look.** A lab sheet rather than a dashboard: warm paper, ink, one signal green for annotations, ember orange only for rejected values; generated ASCII art that animates and stops under reduced motion.

## Deliberately out of scope

- Fuzzy/probabilistic entity resolution — matching is deterministic only (see known limitation above).
- LinkedIn scraping, ATS JSON — not implemented; the `RawFact` + per-source extractor shape makes either a contained extension, as the resume source showed.
- LLMs anywhere outside resume extraction (matching, normalization, confidence, projection) — rejected: those steps have exact rule-based solutions, and an LLM there would make results unexplainable.
