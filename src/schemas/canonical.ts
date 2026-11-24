import { z } from "zod";
import { SourceName } from "./raw-fact.js";

// Provenance method enum — concrete, not vague, so it's defensible in the demo.
export const ProvenanceMethod = z.enum([
  "direct", // value came straight from a source with no transformation needed
  "normalized", // value was transformed by a normalizer (e.g. phone -> E.164)
  "normalization_failed", // fact existed but normalizer returned null
  "precedence_override_conflict", // sources disagreed; higher-precedence source won
  "fallback_match", // candidate was matched via name+company, not email
  "llm_extracted", // value was pulled from resume text by the LLM and passed the grounding check
  "derived", // value was computed from other resolved fields (years_experience)
]);
export type ProvenanceMethod = z.infer<typeof ProvenanceMethod>;

export const ProvenanceEntry = z.object({
  field: z.string(),
  source: SourceName,
  method: ProvenanceMethod,
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntry>;

export const Skill = z.object({
  name: z.string(), // canonical skill name
  confidence: z.number().min(0).max(1),
  sources: z.array(SourceName),
});
export type Skill = z.infer<typeof Skill>;

export const ExperienceEntry = z.object({
  company: z.string(),
  title: z.string(),
  start: z.string().nullable(), // YYYY-MM
  end: z.string().nullable(), // YYYY-MM, null = current
  summary: z.string().nullable(),
});
export type ExperienceEntry = z.infer<typeof ExperienceEntry>;

export const EducationEntry = z.object({
  institution: z.string(),
  degree: z.string(),
  field: z.string(),
  end_year: z.number().nullable(),
});
export type EducationEntry = z.infer<typeof EducationEntry>;

// The canonical candidate profile — internal representation, never returned directly.
// Always pass through the projection stage before emitting.
export const CanonicalCandidate = z.object({
  candidate_id: z.string(),
  full_name: z.string(),
  emails: z.array(z.string()),
  phones: z.array(z.string()), // E.164 format
  location: z.object({
    city: z.string().nullable(),
    region: z.string().nullable(),
    country: z.string().nullable(), // ISO-3166 alpha-2
  }),
  links: z.object({
    linkedin: z.string().nullable(),
    github: z.string().nullable(),
    portfolio: z.string().nullable(),
    other: z.array(z.string()),
  }),
  headline: z.string().nullable(),
  years_experience: z.number().nullable(), // always null for CSV+GitHub — see README
  skills: z.array(Skill),
  experience: z.array(ExperienceEntry),
  education: z.array(EducationEntry), // always empty for CSV+GitHub — see README
  provenance: z.array(ProvenanceEntry),
  overall_confidence: z.number().min(0).max(1),
});
export type CanonicalCandidate = z.infer<typeof CanonicalCandidate>;
