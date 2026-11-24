# CanonVerge — Multi-Source Candidate Data Transformer

[![CI](https://github.com/MalayShikharSoni/CandidateTransformerPipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/MalayShikharSoni/CandidateTransformerPipeline/actions/workflows/ci.yml)

Malay Shikhar Soni · malayshikhar2004@gmail.com

Problem statement: [`docs/problem-statement.md`](docs/problem-statement.md) ·
Design: [`docs/design-doc.md`](docs/design-doc.md)

---

## What this does

Takes candidate data from three sources — a recruiter CSV, GitHub profiles and
resume files — and produces one clean, canonical profile per candidate: normalized formats, merged
across sources, with a full record of where each value came from and how confident
we are in it.

The pipeline is deterministic: same inputs always produce the same output. Every
field is traceable to a source and method. A missing or garbage source never crashes
the run — it contributes zero facts and the rest of the pipeline continues.

It runs as a CLI (below) or as a **web app** (next section).

---

## Web app

A React + Vite front end over a small Hono API that runs the same `runPipeline`
as the CLI. Three pages: a landing page with a live ASCII hero, a **workbench**
(upload a CSV and resumes, watch the 8 stages run, download JSON/NDJSON) and a
**profile** page per candidate (source map, experience timeline, every field
with its source, method and confidence).

```bash
npm run dev          # API on :8787 + Vite on http://localhost:5173 (proxies /api)
npm run dev:replay   # same, but LLM runs replay fixtures/resume-llm-responses.json (no key needed)
npm run build        # CLI + server to dist/, pages to web/dist/
npm start            # one Node process: pages + API on PORT (default 8787)
```

The workbench has a **load sample batch** link (the fixture CSV and four
resumes, copied to `web/public/samples/`).

| Env var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Enables the LLM toggle. Without it, resumes are read with regex only and the UI says so. |
| `GITHUB_TOKEN` / `GH_TOKEN` | 5,000 GitHub requests/hour instead of 60. |
| `PORT` | Server port for `npm start` (`--port` overrides it). |
| `CACHE_DIR` | Where GitHub ETags and LLM answers are cached (default `.cache`). |
| `ACCESS_CODE` | When set, real Claude runs need this code (sent by the workbench as the `x-access-code` header). |
| `LLM_DEMO=1` | LLM runs without real access replay the saved answers for the sample batch (same as `--replay`; `REPLAY_LLM=1` still works). |
| `LLM_DAILY_CAP` | Real Claude calls per UTC day (default 200); after that runs fall back to regex/demo with a note. |
| `LLM_MAX_RESUMES` | Most resumes one real LLM run may send (default 10). |
| `RATE_LIMIT_PER_HOUR` | Runs per client IP per hour (default 0 = unlimited). |
| `TRUSTED_PROXY_HOPS` | `X-Forwarded-For` hops added by your own proxy (Render: 1); 0 uses the socket address. |

**What the server keeps:** nothing. Each run's uploads go to a fresh temp
folder that is deleted when the run ends; results stream back to the browser
and live in that tab (sessionStorage). A CSV's `resume_path` is matched to
uploaded files **by file name only**, so it can never point the server at
other files. Limits: CSV ≤ 5 MB, ≤ 25 resumes of ≤ 10 MB, 50 MB per request.
`/api/health` reports only *whether* keys are set, never their values.

**API:** `GET /api/health`; `POST /api/runs` (multipart: `csv`, `resumes`,
`options` JSON with `llm`, `asOf`, `githubUser`, `config`) answers with a
`text/event-stream` of `stage`, `source`, `warning`, `log` events and a final
`result` (records, stats, warnings, per-field confidences) or `error`.

`Dockerfile` builds the CLI image; `Dockerfile.web` builds the web app (below).

---

## Deploying (Render)

The web app deploys to [Render](https://render.com) from `render.yaml` (a
Blueprint): one Docker web service built from `Dockerfile.web`, health-checked
on `/api/health`, redeployed from `main` only after CI passes.

1. In Render: **New → Blueprint**, connect GitHub, pick this repo.
2. When asked, enter the secrets: `ANTHROPIC_API_KEY`, `ACCESS_CODE` (any
   phrase you'll share with people allowed to run Claude) and optionally
   `GITHUB_TOKEN` (a token with no scopes). They never go in git.
3. The first build takes a few minutes; the app is then at
   `https://canonverge.onrender.com` (or the name Render gives it).

**Who can do what on the public site:** everyone can run batches (regex
extraction) and the LLM *demo*, which replays saved answers for the sample
batch. Real Claude extraction needs the access code. Every IP gets 20 runs an
hour (wrong-code attempts count too), Claude gets at most 200 calls a day and
10 resumes per run.

**Caveats:**
- The `free` plan sleeps after ~15 idle minutes; the next visit takes ~30–60 s
  to wake it. Change `plan` in `render.yaml` to keep it awake.
- The disk is ephemeral: the GitHub and LLM caches reset on each deploy or
  restart (a re-run after that calls Claude again).
- Rate limits and the daily cap live in memory, which is right for one
  instance; running several instances would need a shared store.

Before the first deploy, check that the latest CI run on `main` is green,
including the **Web image** job, which builds `Dockerfile.web` and exercises
it over HTTP.

---

## Quick start

**Prerequisites:** Node.js v22+, npm

```bash
npm install
```

**Set up your GitHub token** (required for the 5,000 req/hr authenticated rate
limit; without it, the GitHub source still works at 60 req/hr):

Create a `.env` file at the project root (already in `.gitignore` — never committed):

```
GITHUB_TOKEN=your_token_here
```

A token with no special scopes is sufficient — only public profile reads are needed.

**For `--llm` (optional)**, add an Anthropic API key to the same `.env`:

```
ANTHROPIC_API_KEY=your_key_here
```

---

## Running the pipeline

```bash
# Single candidate: --github overrides for all CSV rows
npx tsx src/cli.ts --csv fixtures/recruiter.csv --github <username>

# Batch mode: each CSV row uses its own github_username column value
npx tsx src/cli.ts --csv fixtures/recruiter.csv

# Custom output schema
npx tsx src/cli.ts --csv fixtures/recruiter.csv --config fixtures/custom-config.json

# Write output to a file instead of stdout
npx tsx src/cli.ts --csv fixtures/recruiter.csv --output output.json

# Fail the run (exit code 2) if any GitHub call failed
npx tsx src/cli.ts --csv fixtures/recruiter.csv --strict

# One JSON object per line, with machine-readable logs on stderr
npx tsx src/cli.ts --csv fixtures/recruiter.csv --format ndjson --log-format json

# Resumes: rows name a file in the resume_path column (relative to the CSV).
# Without --llm, resumes add emails, phones and profile links (regex only).
npx tsx src/cli.ts --csv fixtures/recruiter-with-resumes.csv

# With --llm, Claude also reads jobs, degrees, headline and skills.
# Sends resume text to the Anthropic API; answers are cached in .cache/llm/.
npx tsx src/cli.ts --csv fixtures/recruiter-with-resumes.csv --llm --as-of 2026-11

# All options
npx tsx src/cli.ts --help
```

**As an installed command** (compiled to `dist/`, exposed through the `bin` field):

```bash
npm run build
npm link            # makes `candidate-transformer` available on your PATH
candidate-transformer --csv fixtures/recruiter.csv
```

**With Docker** (no Node needed; mount the folder with your inputs at `/data`):

```bash
docker build -t candidate-transformer .
docker run --rm -e GITHUB_TOKEN -v "$PWD:/data" candidate-transformer --csv fixtures/recruiter.csv
# add -e ANTHROPIC_API_KEY and --llm to read resumes with Claude
```

**Arguments:**

| Flag | Required | Description |
|---|---|---|
| `--csv <path>` | Yes | Path to recruiter CSV |
| `--github <username>` | No | GitHub username — applied to all rows. If omitted, each row uses its `github_username` column value |
| `--llm` | No | Read jobs, degrees, headline and skills from resumes with Claude (needs `ANTHROPIC_API_KEY`). Without it, resumes give regex facts only |
| `--as-of <YYYY-MM>` | No | Month that ongoing jobs run to for `years_experience` (default: current month). Fix it for reproducible output |
| `--config <path>` | No | Custom ProjectionConfig JSON. Defaults to full canonical schema |
| `--output <path>` | No | Write output to a file instead of stdout |
| `--format <json\|ndjson>` | No | JSON array (default), or one record per line for tools like `jq` and bulk loaders |
| `--strict` | No | Exit with code `2` if any source failed (bad token, rate limit, unknown user, unreadable resume, LLM error) |
| `--cache-dir <path>` | No | Cache folder: GitHub ETags in `github/`, LLM answers in `llm/` (default `.cache`) |
| `--no-cache` | No | Don't read or write either cache |
| `--log-format <text\|json>` | No | stderr messages as text (default) or one JSON object per line |
| `-h, --help` | No | Show all options |

**stderr vs stdout:** stdout carries only the output, so it can be piped
straight into another program. Everything else goes to stderr: GitHub warnings
(a failed call means the run finishes without that source, but says why) and
a one-line summary:

```
warning: github "someone": GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN in .env.
summary: 4 CSV rows -> 4 candidates (0 errors) | GitHub: 1 username, 0 with warnings, 2 cache hits, 4998 requests left this hour | 261 ms
```

With `--log-format json`, the same lines are JSON objects
(`{"level":"warn","event":"source_warning",...}`, `{"event":"run_summary",...}`)
for CI logs or a log collector.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Run finished. Per-candidate problems appear as `{ "error": "..." }` entries in the output array. |
| `1` | Setup error: CSV missing or unreadable, CSV missing required columns, invalid config file. |
| `2` | `--strict` was set and at least one source call failed. |

---

## Sample inputs

`fixtures/recruiter.csv` — four candidates with deliberate edge cases:

| Candidate | Edge case exercised |
|---|---|
| Malay Shikhar Soni | Clean row + cross-source GitHub merge (skills, headline, location) |
| Aditi Rao | Variant phone format (no country code) |
| Rohan Mehta | Missing email + garbage phone `"123"` — fallback match key, normalization_failed provenance |
| Priya Nair | Missing company field |

The CSV includes an optional `github_username` column — Malay's row is populated;
others are empty (CSV-only processing for those candidates).

`fixtures/recruiter-with-resumes.csv` — five fictional candidates whose
`resume_path` points into `fixtures/resumes/` (one points to a missing file, to
show the warning). The ten resumes there are synthetic (PDF one- and two-column,
DOCX, TXT, MD), generated by `npm run fixtures:resumes` from
`scripts/resume-fixtures-data.ts`, with hand-written answer keys in
`fixtures/resumes/labels/`.

`fixtures/custom-config.json` — custom projection: field subset, renames
(`emails[0]` → `primary_email`), E.164 re-normalization, `skills[].name` wildcard
path, confidence on.

---

## Tests, linting and CI

```bash
npm test            # 212 tests (pipeline, server and web app)
npm run coverage    # tests + coverage report (fails below 85% lines)
npm run lint        # ESLint with type-aware rules
npm run typecheck   # tsc over src, tests and scripts, then over web/
npm run check       # all of the above, same as CI
```

GitHub is always mocked through the adapter's injectable `fetch`, and the
resume LLM through an injected extractor that replays
`fixtures/resume-llm-responses.json`, so tests never touch the network. Coverage is about 95% of lines and 88% of branches.

| File | What it covers |
|---|---|
| `tests/golden.test.ts` | Full pipeline on the sample inputs, compared with output files in `tests/golden/`. Any change to the output shows up as a diff in review. Also checks that two runs give identical output. After an intended change, regenerate with `npx vitest run -u`. |
| `tests/pipeline.test.ts` | The five design-doc edge cases (below) |
| `tests/pipeline-events.test.ts` | Progress events in stage order, the upload-name resume resolver (including a path-traversal attempt), per-field confidences |
| `tests/server.test.ts` | The API: health, a full streamed run, regex-only fallback, custom config, bad requests, 413 over the size limit, safe file names |
| `web/src/**/*.test.ts(x)` | ASCII portrait, SSE parser (events split across chunks), CSV preview, the workbench run flow against a mocked stream, the profile page |
| `tests/fixes.test.ts` | Merge linking, per-skill scores, GitHub failure handling, CSV errors, default schema |
| `tests/normalizers.test.ts` | Phone, date, country and skill normalizers, including inputs that must be rejected |
| `tests/projection.test.ts` | Path parsing, renames, wildcards, `on_missing`, provenance filtering, output validation |
| `tests/cache-and-log.test.ts` | ETag revalidation, cache files on disk, text and JSON log output |
| `tests/edge-cases.test.ts` | Network errors, non-JSON and malformed GitHub responses, long rate-limit resets, one username shared across rows, unparseable CSV, duplicate emails, `name+company` matching, type coercion |
| `tests/resume-adapter.test.ts` | PDF/DOCX/TXT/MD text extraction, regex facts (dates that look like phones are ignored), unreadable files, LLM cache hits and misses |
| `tests/resume-grounding.test.ts` | The grounding check: invented jobs, skills and headlines dropped; reworded titles and missing dates blanked; whole-word and nearby matching |
| `tests/resume-llm.test.ts` | The Claude call with a stubbed client: request shape, refusal, cut-off and schema-mismatch answers, API errors turned into warnings |
| `tests/resume-pipeline.test.ts` | Resumes end to end: CSV job merged with resume dates, education, `years_experience`, provenance, cached re-runs giving identical output, every LLM call failing |

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request, on
Ubuntu and Windows: lint, type-check, tests with coverage, build, then one real
end-to-end run of the built CLI against the GitHub API using the workflow's own
token. A second job builds the Docker image and runs it on the sample CSV.

`tests/pipeline.test.ts`, one per design-doc edge case:

1. **Missing source entirely** — pipeline continues with CSV-only facts, no crash
2. **Conflicting non-null values** — CSV wins by precedence, conflict flagged in provenance
3. **Malformed structured data** — bad phone excluded, `normalization_failed` in provenance
4. **Sparse unstructured source** — GitHub contributes only what it has, no crash
5. **Custom config `on_missing: "error"`** — missing required field returns `{ error }`

---

## Performance

`npm run benchmark` generates synthetic CSVs (seeded, so the data is the same
every run: about 20% of rows with a GitHub username, 5% duplicate emails, 10%
invalid phones) and runs the full pipeline on each. GitHub is mocked with
instant responses, so this measures the pipeline itself, not the network.

Node 22.13, Windows 11, x64 laptop:

| CSV rows | GitHub users | Candidates out | Time | Rows/sec | Peak memory |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 221 | 962 | 0.17 s | 5,929 | 112 MB |
| 10,000 | 2,094 | 9,484 | 0.81 s | 12,301 | 144 MB |
| 50,000 | 10,553 | 47,396 | 5.01 s | 9,971 | 306 MB |

"Candidates out" is lower than rows because duplicate emails merge into one
candidate. With a real GitHub API, the hourly budget is the limit, not the
pipeline (see **ingest** below).

---

## Resume extraction quality

```bash
npm run eval:resumes -- --replay   # score the saved answers, no API calls
npm run eval:resumes               # call Claude once per resume (needs ANTHROPIC_API_KEY)
npm run eval:resumes -- --record   # same, and save the answers for the tests to replay
```

Scores what survives the grounding check against the answer keys, per field:
precision (extracted items that are right) and recall (real items found), plus
the number of values grounding dropped.

`fixtures/resume-llm-responses.json` currently holds **hand-written stand-ins**,
not real model answers: the answer keys plus three planted mistakes that the
grounding check removes. Replaying them proves the scoring and grounding work;
it says nothing about the model. Run with `--record` to replace them with real
answers and get real numbers.

---

## GitHub response cache

Each GitHub response is saved in `.cache/github/` together with its `ETag`.
On the next run the request carries `If-None-Match`; if the profile hasn't
changed, GitHub answers `304 Not Modified` with no body and the saved copy is
used. Data is never stale, because every run still asks GitHub; it just doesn't
download unchanged data again. With a token, GitHub doesn't count 304 responses
against the hourly limit, so re-running a batch costs almost none of the budget.
(Without a token, GitHub still counts them.) Cache files are written to a temp
file and renamed, so an interrupted run never leaves a half-written file. A
cache that can't be read or written is ignored, never fatal. Disable it with
`--no-cache`.

---

## Pipeline stages

```
ingest → extract → normalize → merge → confidence → project → validate → emit
```

Each stage is a pure function with typed inputs/outputs. No stage reaches into
another's internals. `src/pipeline.ts` (`runPipeline`) runs all stages and
touches neither the console nor `process`. `src/cli.ts` only parses flags,
prints, and sets the exit code, so the CLI, the tests and the benchmark all run
the same code.

- **ingest** — reads the CSV with a streaming parser and calls the GitHub REST
  API (profile + repo languages, 2 calls per candidate). A failed call produces
  zero facts for that source plus a warning on stderr, never a crash. GitHub
  calls are deduplicated by username, and two separate limits are handled:
  - *Concurrency:* `p-limit(10)` keeps at most 10 requests in flight.
  - *Hourly budget:* every response's `X-RateLimit-Remaining`/`X-RateLimit-Reset`
    headers feed one shared `RateLimitState`. Once the budget hits 0, remaining
    calls are skipped with a warning instead of being sent. A `429`, or a `403`
    with `Retry-After`, is retried once if the wait is 60 s or less.

  At 2 calls per candidate, the 5,000 req/hr authenticated budget covers about
  2,500 new GitHub usernames per hour. Larger batches need to run across
  several hours.
- **extract** — maps each source's native shape into
  `RawFact { field, rawValue, source, sourceMethod, rowIndex }`. Processing logic
  is source-agnostic downstream; `source`/`sourceMethod` travel with every value
  to build the final provenance array. `rowIndex` tags which CSV row (or GitHub
  call index) a fact belongs to, enabling correct cross-source grouping.
- **normalize** — pure per-field transforms: phone → E.164 (`libphonenumber-js`),
  dates → `YYYY-MM`, country → ISO-3166 alpha-2 (including state→country inference
  for Indian locations, e.g. "Punjab" → "IN"), skills → canonical name via synonym
  map. Unparseable input → `null`, never a guess, never a throw.
- **merge** — GitHub facts are paired with the CSV row they were fetched for
  (a Map lookup by `rowIndex`, O(n)). If the row's own `github_username` column
  named the profile, the pair always merges, because the recruiter already linked
  them. A different display name becomes a recorded conflict, not a second
  person. If the username came from `--github` (applied to every row), the pair
  merges only when name and email don't contradict the CSV row. Facts are
  then grouped by match key (`email` priority, `name+company` fallback), taken
  from the CSV facts when present. `candidate_id = sha256(matchKey)`, so a
  merged-in GitHub email never changes a candidate's id. Precedence: structured (CSV) before unstructured
  (GitHub), but only if the CSV value is non-null *and* passed normalization. A
  malformed CSV phone never beats a valid GitHub-derived one. Conflicts are recorded
  in provenance (`method: "precedence_override_conflict"`), never silently dropped.
- **confidence** — per-field score independent of which value won: CSV base `0.9`,
  GitHub base `0.6`, `+0.1` if sources agree, `×0.5` if normalization failed.
  Clamped `[0,1]`. Each skill is scored on its own with the same rule, so it
  carries its own `confidence` and `sources[]`. `overall_confidence` is the
  average across populated fields.
- **project** — applies the runtime config to the canonical record without mutating
  it. Supports array-wildcard paths (`skills[].name`), field renames, per-field
  normalize overrides, and `on_missing: null | omit | error`. `required: true` only
  has behavioral effect in `error` mode — under `null`/`omit` it is documentation
  only, matching the spec's single global `on_missing` policy.
- **validate** — builds a Zod schema dynamically from the config and validates the
  projected output before emitting. `.strict()` rejects unexpected keys — any
  extra key signals a projection bug, not a data issue. Object fields copied
  from a top-level canonical field (`location`, `links`, `skills`,
  `experience`, ...) are checked against that field's canonical Zod schema,
  key by key.

---

## What the output looks like

First record of a live default run (6 Nov 2026) against `fixtures/recruiter.csv`,
with `malayshikharsoni` as the GitHub source (from the CSV column). Skills are
shortened to three of the seven:

```json
{
  "candidate_id": "fbc06e803f282378d5eab062f9519d9bb66129622ef57d694dedf73c3391538e",
  "full_name": "Malay Shikhar Soni",
  "emails": ["malayshikhar2004@gmail.com"],
  "phones": ["+919876543210"],
  "location": { "city": "Phagwara", "region": null, "country": "IN" },
  "links": {
    "linkedin": null,
    "github": "https://github.com/MalayShikharSoni",
    "portfolio": null,
    "other": []
  },
  "headline": "B.Tech CSE @ LPU | Backend dev, Node.js & TypeScript",
  "years_experience": null,
  "skills": [
    { "name": "Java", "confidence": 0.6, "sources": ["github"] },
    { "name": "TypeScript", "confidence": 0.6, "sources": ["github"] },
    { "name": "C++", "confidence": 0.6, "sources": ["github"] }
  ],
  "experience": [
    { "company": "Techvanto Academy", "title": "Backend Intern", "start": null, "end": null, "summary": null }
  ],
  "education": [],
  "overall_confidence": 0.7857142857142857,
  "provenance": [
    { "field": "full_name", "source": "csv", "method": "direct" },
    { "field": "headline", "source": "github", "method": "direct" },
    { "field": "links.github", "source": "github", "method": "direct" },
    { "field": "emails", "source": "csv", "method": "direct" },
    { "field": "phones", "source": "csv", "method": "normalized" },
    { "field": "skills", "source": "github", "method": "direct" },
    { "field": "experience", "source": "csv", "method": "direct" },
    { "field": "location", "source": "github", "method": "direct" }
  ]
}
```

---

## Deliberate design decisions

**An LLM in exactly one place: reading resume layout.** Everything with an exact
rule (CSV columns, GitHub fields, emails, phones, URLs, dates, matching,
confidence) stays rule-based. Jobs and degrees in a resume depend on layout, where
rules break down, so `--llm` has Claude read them. Its answers are cached by
content hash, so re-runs are byte-identical, and every value must appear in the
resume word for word (the grounding check) before it becomes a fact. LLM facts
have the lowest confidence and never outrank the CSV. See the design doc.

**Normalization must pass for a source to win merge.** A present-but-malformed
value (e.g. `"123"` as a phone number) never beats a valid value from a
lower-precedence source. "Wrong-but-confident is worse than honestly-empty" — this
is where that principle is enforced in code.

**`normalization_failed` provenance method.** When a fact existed but failed
normalization, the provenance entry is still emitted so the output distinguishes
"no phone was ever provided" from "a phone was provided but it was invalid." Both
are honest; only the second is explainable without this entry.

**`rowIndex` tagging for correct cross-source grouping.** GitHub facts are stamped
with the CSV `rowIndex` of the row they were fetched for, before grouping runs.
Each CSV row is then paired only with its own GitHub data, instead of all GitHub
facts being treated as one pool. That pool approach would have merged wrongly
when running `--github` with a username that only matches one CSV candidate.

**A row's own `github_username` is trusted as a link.** When the CSV row itself
names the GitHub profile, a different display name ("Malay S.") or a second
email doesn't split the person into two records. The CSV value wins and the
disagreement is recorded as `precedence_override_conflict`. The stricter
name/email check applies only to `--github`, which links one profile to every
row without anyone confirming the match.

**Projection and canonical model are fully decoupled.** The canonical record is
built once. Any number of output shapes can be produced from it by passing
different configs — the engine never changes, only the config does.

**`required: true` is documentation-only outside `error` mode.** Under `null` or
`omit` on_missing modes, `required: true` has no behavioral effect. This matches
the spec's framing of `on_missing` as a single global policy rather than adding a
second, per-field override that conflicts with it.

---

## Known limitations / deliberately out of scope

- **`years_experience` and `education[]`** — only filled from resumes with
  `--llm`; otherwise `null`/empty. Jobs without a stated end date are left out of
  `years_experience` rather than guessed.
- **Resume grounding proves presence, not truth** — a value must be in the
  resume, but the resume itself can be wrong. Scanned PDFs need OCR first.
  Two-digit years ("Jan '21") don't normalize; the job is kept without dates.
- **LinkedIn scraping, ATS JSON** — not implemented. The `RawFact` + per-source
  extractor shape makes either a contained extension, as the resume source showed.
- **GitHub skills source** — one extra API call (`/users/{username}/repos?per_page=10`)
  fetches primary repo languages. This is intentionally limited to 10 repos and
  primary language only; full language breakdown would require N+1 calls per repo.
- **`name+company` match key collision** — two candidates with identical name and
  company would merge incorrectly. Accepted at this scope; email is the safe key.
- **Location parsing** — free-text GitHub location strings are split on the last
  comma: the part before is `city`, the part after is looked up as a country.
  "Punjab" maps to "IN" via a context-specific alias (Indian candidate profiles),
  so "Lahore, Punjab" (in Pakistan) would wrongly get `country: "IN"`. Region
  names are used only as a country hint; `region` stays `null`. Documented and
  accepted for this scope.
- **`GITHUB_TOKEN` env var** — supports both `GITHUB_TOKEN` and `GH_TOKEN`
  (checked in that order). Without a token GitHub allows 60 req/hr, about 30
  candidates, and the CLI prints a note saying so. An expired token returns
  HTTP 401 and shows up as a warning.
- **Memory** — the CSV is parsed as a stream, but all facts are kept in memory
  until grouping (two rows anywhere in the file can be the same person), so
  memory grows with the number of rows: about 300 MB at 50,000 rows (see
  **Performance**). `--format ndjson` changes the output format, not this.

---

## Stack

Node.js + TypeScript · `zod` · `csv-parse` · `libphonenumber-js` · `p-limit` ·
`dotenv` · native `fetch` · `unpdf` · `mammoth` · `@anthropic-ai/sdk`

Web: `hono` + `@hono/node-server` · React 19 · `react-router` · Vite ·
self-hosted Space Grotesk, Inter Tight and JetBrains Mono

Dev: `vitest` + `@vitest/coverage-v8` · jsdom + Testing Library · ESLint 9 +
`typescript-eslint` + `react-hooks` · `pdf-lib` + `docx` (fixture generation) ·
`concurrently` · GitHub Actions · Docker

One opt-in LLM call (resume extraction), no database, a stateless API. Each run
happens entirely in memory.