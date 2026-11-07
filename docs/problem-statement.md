# Problem Statement — Multi-Source Candidate Data Transformer

`docs/design-doc.md` describes how this is solved. `PROJECT_CONTEXT.md` turns those
decisions into implementation rules.

## The problem

Hiring platforms collect candidate information from many places at once. Downstream
products need one clean, canonical profile per candidate: a fixed set of fields,
normalized formats, deduplicated across sources, and a record of where each value
came from and how confident we are in it. A wrong-but-confident value is worse than
an honestly empty one, because it silently pollutes hiring decisions. The goal is a
transformer that turns messy inputs into that one trustworthy profile.

## Inputs

Sources fall into two groups. The transformer handles at least one from each. Any
source may be missing, empty or malformed, and the same person may appear in several
sources with conflicting values.

**Structured sources**
- Recruiter CSV export — rows with name, email, phone, current_company, title.
- ATS JSON blob — semi-structured, with its own field names that don't match ours.

**Unstructured sources**
- GitHub profile — public REST API (name, bio, repos, languages).
- LinkedIn profile — name, headline, experience, education.
- Resume files — PDF / DOCX prose.
- Recruiter notes — free text.

**Used in this project:** recruiter CSV (structured) + GitHub profile (unstructured).
The design doc explains why.

## Canonical output schema

| Field | Type / shape | Notes |
|---|---|---|
| candidate_id | string | |
| full_name | string | |
| emails | string[] | |
| phones | string[] | E.164 format |
| location | { city, region, country } | country: ISO-3166 alpha-2 |
| links | { linkedin, github, portfolio, other[] } | |
| headline | string \| null | |
| years_experience | number \| null | |
| skills | [{ name, confidence, sources[] }] | canonical skill names |
| experience | [{ company, title, start, end, summary }] | dates as YYYY-MM |
| education | [{ institution, degree, field, end_year }] | |
| provenance | [{ field, source, method }] | where each value came from |
| overall_confidence | number | |

## Configurable output

On top of the default schema, the pipeline accepts a runtime config that reshapes
the output with no code changes. The config can:

- Select a subset of fields.
- Rename or remap a field from a canonical path (the `from` key).
- Set per-field normalization (e.g. E.164 for phones, canonical names for skills).
- Turn provenance and confidence on or off.
- Choose what happens when a value is missing: `null`, `omit` or `error`.

The internal canonical record and the projection layer stay separate, and the
result is validated against the requested schema.

### Example config

```json
{
  "fields": [
    { "path": "full_name", "type": "string", "required": true },
    { "path": "primary_email", "from": "emails[0]", "type": "string", "required": true },
    { "path": "phone", "from": "phones[0]", "type": "string", "normalize": "E164" },
    { "path": "skills", "from": "skills[].name", "type": "string[]", "normalize": "canonical" }
  ],
  "include_confidence": true,
  "on_missing": "null"
}
```

## Interface

A thin way to feed inputs in and see the result: a command-line tool that takes the
input files and a config and prints or writes the JSON.

## Constraints

- **Deterministic and explainable** — the same inputs always produce the same
  output, and every field is traceable to a source and method.
- **Robust** — a missing or garbage source never crashes the run; unknown values
  become null, never invented.
- **Scale** — reasonable on thousands of candidates.

## Requirements

- Runs end to end on the sample inputs and emits schema-valid JSON for the default
  schema and at least one custom config.
- Covers at least one structured and one unstructured source.
- Normalizes dates and phones at minimum, and canonicalizes skills.
- Merges across sources into one record, with provenance and confidence populated.
- Validates output before returning it, and degrades gracefully on a missing or
  garbage source.
- Has tests, including at least one edge case.
