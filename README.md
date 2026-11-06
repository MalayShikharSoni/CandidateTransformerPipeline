# Multi-Source Candidate Data Transformer

**Eightfold Engineering Intern (Jul–Dec 2026) — Stage 2 submission**
Malay Shikhar Soni · malayshikhar2004@gmail.com

---

## What this does

Takes candidate data from two sources — a recruiter CSV and GitHub profiles — and
produces one clean, canonical profile per candidate: normalized formats, merged
across sources, with a full record of where each value came from and how confident
we are in it.

The pipeline is deterministic: same inputs always produce the same output. Every
field is traceable to a source and method. A missing or garbage source never crashes
the run — it contributes zero facts and the rest of the pipeline continues.

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
```

**Arguments:**

| Flag | Required | Description |
|---|---|---|
| `--csv <path>` | Yes | Path to recruiter CSV |
| `--github <username>` | No | GitHub username — applied to all rows. If omitted, each row uses its `github_username` column value |
| `--config <path>` | No | Custom ProjectionConfig JSON. Defaults to full canonical schema |
| `--output <path>` | No | Write JSON to file instead of stdout |
| `--strict` | No | Exit with code `2` if any source call failed (bad token, rate limit, unknown user) |

**Warnings:** when a GitHub call fails, the run still finishes without that
source, but the reason goes to stderr, e.g.
`warning: github "someone": GitHub rejected the token (HTTP 401). Check GITHUB_TOKEN in .env.`
stdout stays pure JSON.

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

`fixtures/custom-config.json` — custom projection: field subset, renames
(`emails[0]` → `primary_email`), E.164 re-normalization, `skills[].name` wildcard
path, confidence on.

---

## Running tests

```bash
npm test
# Verbose:
npx vitest run --reporter=verbose
```

19 tests. GitHub is always mocked through the adapter's injectable `fetch`, so
tests never touch the network.

`tests/pipeline.test.ts`, one per design-doc edge case:

1. **Missing source entirely** — pipeline continues with CSV-only facts, no crash
2. **Conflicting non-null values** — CSV wins by precedence, conflict flagged in provenance
3. **Malformed structured data** — bad phone excluded, `normalization_failed` in provenance
4. **Sparse unstructured source** — GitHub contributes only what it has, no crash
5. **Custom config `on_missing: "error"`** — missing required field returns `{ error }`

`tests/fixes.test.ts`:

- **Merge:** a row-linked GitHub profile with a different display name and a
  second email merges into one record, flags the conflict, and keeps the CSV
  row's `candidate_id`. An unlinked mismatch stays separate. GitHub data only
  pairs with the CSV row it was fetched for.
- **Skills:** a skill seen in both sources scores higher than one seen in one source.
- **GitHub failures:** 401, 404, retry after `Retry-After`, skipping calls once the
  hourly budget is used up, keeping profile facts when only the repos call fails.
- **CSV:** missing columns and missing files are reported as errors.
- **Validation:** the default config passes, and an object with wrong key types fails.

Type-check and test together with `npm run check`.

---

## Pipeline stages

```
ingest → extract → normalize → merge → confidence → project → validate → emit
```

Each stage is a pure function with typed inputs/outputs. No stage reaches into
another's internals.

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

**No LLM/agent extraction.** The spec requires deterministic output — same inputs,
same output, always. LLM calls introduce non-determinism and add an unexplainable
layer to a problem with a clean rule-based solution. Explicitly rejected, not an
oversight.

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

- **`years_experience` and `education[]`** — always `null`/empty. Neither CSV nor
  GitHub API provides this data. Would require resume parsing (PDF/DOCX), which
  was descoped to avoid heuristic extraction that would produce wrong-but-confident
  output — the exact failure mode this pipeline is designed to prevent.
- **LinkedIn scraping** — not implemented. The `RawFact` + per-source extractor
  shape makes it a contained extension.
- **GitHub skills source** — one extra API call (`/users/{username}/repos?per_page=10`)
  fetches primary repo languages. This is intentionally limited to 10 repos and
  primary language only; full language breakdown would require N+1 calls per repo.
- **`name+company` match key collision** — two candidates with identical name and
  company would merge incorrectly. Accepted at this scope; email is the safe key.
- **Location parsing** — free-text GitHub location strings are parsed by splitting
  on the last comma. "Punjab" maps to "IN" via a context-specific alias (Indian
  candidate profiles). Ambiguous strings (e.g. "Punjab, Pakistan") would incorrectly
  map to "IN" — documented and accepted for this scope.
- **`GITHUB_TOKEN` env var** — supports both `GITHUB_TOKEN` and `GH_TOKEN`
  (checked in that order). Without a token GitHub allows 60 req/hr, about 30
  candidates, and the CLI prints a note saying so. An expired token returns
  HTTP 401 and shows up as a warning.
- **Memory** — the CSV is parsed as a stream, but all facts are kept in memory
  until grouping, so memory grows with the number of rows. That's fine for
  thousands of candidates. Constant-memory output (NDJSON) is a planned extension.

---

## Stack

Node.js + TypeScript · `zod` · `csv-parse` · `libphonenumber-js` · `p-limit` ·
`vitest` · `dotenv` · native `fetch`

No LLM, no database, no server framework. Runs entirely in memory for a single
CLI invocation.