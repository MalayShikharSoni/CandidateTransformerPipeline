import type { RunResult } from "../lib/types";

/** A trimmed-down real result for Ananya Iyer (fixtures/recruiter-with-resumes.csv, LLM replay). */
export const ANANYA_ID = "a6f29f9b1ef38e167503d7c187d1d63da38908cefef9690456f49820aff8a628";

export const SAMPLE_RESULT: RunResult = {
  records: [
    {
      candidate_id: ANANYA_ID,
      full_name: "Ananya Iyer",
      emails: ["ananya.iyer@example.com"],
      phones: ["+919876543101"],
      location: { city: null, region: null, country: null },
      links: {
        linkedin: "https://www.linkedin.com/in/ananya-iyer-dev",
        github: null,
        portfolio: "https://ananya.example.dev",
        other: [],
      },
      headline: "Senior Backend Engineer",
      years_experience: 8.4,
      skills: [{ name: "Go", confidence: 0.5, sources: ["resume"] }],
      experience: [
        { company: "Northwind Labs", title: "Senior Backend Engineer", start: "2022-01", end: null, summary: null },
        { company: "Contoso Retail", title: "Software Engineer", start: "2018-07", end: "2021-12", summary: null },
      ],
      education: [
        { institution: "Indian Institute of Technology Madras", degree: "B.Tech", field: "Computer Science", end_year: 2018 },
      ],
      overall_confidence: 0.74,
      provenance: [
        { field: "full_name", source: "csv", method: "direct" },
        { field: "headline", source: "resume", method: "llm_extracted" },
        { field: "emails", source: "csv", method: "direct" },
        { field: "experience", source: "csv", method: "direct" },
        { field: "experience", source: "resume", method: "llm_extracted" },
        { field: "years_experience", source: "resume", method: "derived" },
      ],
    },
    {
      candidate_id: "b".repeat(64),
      full_name: "Ravi Kumar",
      emails: ["ravi.kumar@example.com"],
      phones: [],
      location: { city: null, region: null, country: null },
      links: { linkedin: null, github: null, portfolio: null, other: [] },
      headline: null,
      years_experience: null,
      skills: [],
      experience: [{ company: "Litware Inc", title: "Support Engineer", start: null, end: null, summary: null }],
      education: [],
      overall_confidence: 0.9,
      provenance: [{ field: "full_name", source: "csv", method: "direct" }],
    },
  ],
  stats: {
    csvRows: 2,
    githubUsernames: 0,
    githubUsernamesWithWarnings: 0,
    githubCacheHits: 0,
    githubRateLimitRemaining: null,
    resumes: 2,
    resumesWithWarnings: 1,
    resumeLlmCalls: 1,
    resumeLlmCacheHits: 0,
    resumeValuesDropped: 2,
    candidates: 2,
    candidateErrors: 0,
  },
  warnings: [{ source: "resume", subject: "resumes/ravi-kumar.pdf", message: "no uploaded file has this name." }],
  details: [
    { candidate_id: ANANYA_ID, fieldConfidence: { full_name: 0.9, headline: 0.5, experience: 0.9 } },
    { candidate_id: "b".repeat(64), fieldConfidence: { full_name: 0.9 } },
  ],
  schema: "default",
  asOf: "2026-11",
  llmUsed: true,
};
