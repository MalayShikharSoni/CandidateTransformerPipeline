// Shapes the API sends (see src/server/run.ts and src/schemas/canonical.ts).
// Kept separate from the server code so the browser bundle never pulls in Node modules.

export type SourceName = "csv" | "resume" | "github";

export interface ProvenanceEntry {
  field: string;
  source: SourceName;
  method: string;
}

export interface SkillEntry {
  name: string;
  confidence: number;
  sources: SourceName[];
}

export interface ExperienceEntry {
  company: string;
  title: string;
  start: string | null;
  end: string | null;
  summary: string | null;
}

export interface EducationEntry {
  institution: string;
  degree: string;
  field: string;
  end_year: number | null;
}

/** A record in the default schema. Custom-schema records are plain objects. */
export interface Candidate {
  candidate_id: string;
  full_name: string;
  emails: string[];
  phones: string[];
  location: { city: string | null; region: string | null; country: string | null } | null;
  links: { linkedin: string | null; github: string | null; portfolio: string | null; other: string[] } | null;
  headline: string | null;
  years_experience: number | null;
  skills: SkillEntry[];
  experience: ExperienceEntry[];
  education: EducationEntry[];
  provenance?: ProvenanceEntry[];
  overall_confidence?: number;
}

export type OutputRecord = Record<string, unknown> | { error: string };

export interface SourceWarning {
  source: "github" | "resume";
  subject: string;
  message: string;
}

export interface RunStats {
  csvRows: number;
  githubUsernames: number;
  githubUsernamesWithWarnings: number;
  githubCacheHits: number;
  githubRateLimitRemaining: number | null;
  resumes: number;
  resumesWithWarnings: number;
  resumeLlmCalls: number;
  resumeLlmCacheHits: number;
  resumeValuesDropped: number;
  candidates: number;
  candidateErrors: number;
}

export interface CandidateDetail {
  candidate_id: string;
  fieldConfidence: Record<string, number>;
}

export interface RunResult {
  records: OutputRecord[];
  stats: RunStats;
  warnings: SourceWarning[];
  details: CandidateDetail[];
  schema: "default" | "custom";
  asOf: string | null;
  llmUsed: boolean;
  llmMode?: "claude" | "demo" | "none";
}

export const STAGES = [
  "ingest",
  "extract",
  "normalize",
  "merge",
  "confidence",
  "project",
  "validate",
  "emit",
] as const;
export type StageName = (typeof STAGES)[number];

export type RunEvent =
  | { event: "stage"; data: { stage: StageName; status: "start" | "done" } }
  | { event: "source"; data: { source: string; subject: string; ok: boolean } }
  | { event: "warning"; data: SourceWarning }
  | { event: "log"; data: { level: "info" | "note"; text: string } }
  | { event: "result"; data: RunResult }
  | { event: "error"; data: { error: string } };

export interface Health {
  ok: boolean;
  llmAvailable: boolean;
  /** Real Claude runs: open to all, behind an access code, or not set up. */
  llmAccess: "open" | "code" | "off";
  /** LLM runs without real access replay saved answers for the sample batch. */
  llmDemo: boolean;
  githubToken: boolean;
}
