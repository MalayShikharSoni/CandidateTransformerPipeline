import type { SourceWarning } from "./adapters/github.js";
import type { PipelineStats } from "./pipeline.js";

/**
 * Everything except the output itself goes to stderr, so stdout stays pure
 * JSON that can be piped into jq or a file. "text" is for people;
 * "json" (one JSON object per line) is for CI logs and log collectors.
 */
export type LogFormat = "text" | "json";

export interface Logger {
  note(message: string): void;
  warning(warning: SourceWarning): void;
  error(message: string): void;
  summary(stats: PipelineStats, durationMs: number): void;
}

type WriteLine = (line: string) => void;

const toStderr: WriteLine = (line) => {
  process.stderr.write(`${line}\n`);
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function textSummary(stats: PipelineStats, durationMs: number): string {
  const parts = [
    `${plural(stats.csvRows, "CSV row")} -> ${plural(stats.candidates, "candidate")} (${plural(stats.candidateErrors, "error")})`,
  ];
  if (stats.githubUsernames > 0) {
    const left =
      stats.githubRateLimitRemaining === null
        ? ""
        : `, ${stats.githubRateLimitRemaining} requests left this hour`;
    parts.push(
      `GitHub: ${plural(stats.githubUsernames, "username")}, ${stats.githubUsernamesWithWarnings} with warnings, ${plural(stats.githubCacheHits, "cache hit")}${left}`,
    );
  }
  parts.push(`${Math.round(durationMs)} ms`);
  return `summary: ${parts.join(" | ")}`;
}

export function createLogger(format: LogFormat, write: WriteLine = toStderr): Logger {
  if (format === "json") {
    const emit = (record: Record<string, unknown>) => write(JSON.stringify(record));
    return {
      note: (message) => emit({ level: "info", event: "note", message }),
      warning: (w) => emit({ level: "warn", event: "source_warning", ...w }),
      error: (message) => emit({ level: "error", event: "error", message }),
      summary: (stats, durationMs) =>
        emit({ level: "info", event: "run_summary", ...stats, durationMs: Math.round(durationMs) }),
    };
  }

  return {
    note: (message) => write(`note: ${message}`),
    warning: (w) => write(`warning: ${w.source} "${w.username}": ${w.message}`),
    error: (message) => write(`Error: ${message}`),
    summary: (stats, durationMs) => write(textSummary(stats, durationMs)),
  };
}
