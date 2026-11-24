/** Something went wrong with a source, but the run carried on without it. */
export interface SourceWarning {
  source: "github" | "resume";
  /** What the warning is about: a GitHub username or a resume path. */
  subject: string;
  message: string;
}

/** Stable order, so warning output doesn't depend on which call finished first. */
export function sortWarnings(warnings: SourceWarning[]): SourceWarning[] {
  return [...warnings].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.subject.localeCompare(b.subject) ||
      a.message.localeCompare(b.message),
  );
}
