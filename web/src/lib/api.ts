import { createSseParser } from "./sse";
import type { Health, RunEvent } from "./types";

export interface RunRequest {
  csv: File;
  resumes: File[];
  options: { llm: boolean; asOf?: string; githubUser?: string; config?: unknown };
  /** Unlocks real LLM runs on servers that require one. Sent as a header, never stored. */
  accessCode?: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error(`health check failed (HTTP ${response.status})`);
  return (await response.json()) as Health;
}

/**
 * Starts a run and calls onEvent for each server-sent event as it arrives.
 * Resolves when the stream ends; rejects with the server's message on a bad request.
 */
export async function startRun(
  request: RunRequest,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("csv", request.csv);
  for (const resume of request.resumes) form.append("resumes", resume);
  form.append("options", JSON.stringify(request.options));

  const headers: Record<string, string> = {};
  if (request.accessCode) headers["x-access-code"] = request.accessCode;
  const response = await fetch("/api/runs", { method: "POST", body: form, headers, signal });
  if (!response.ok || response.body === null) {
    let message = `the server answered HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }

  const parser = createSseParser(({ event, data }) => {
    try {
      const parsed: unknown = JSON.parse(data);
      onEvent({ event, data: parsed } as RunEvent);
    } catch {
      // ignore a malformed event rather than abort the run view
    }
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(value);
  }
  parser.end();
}
