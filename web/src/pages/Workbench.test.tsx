// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RunProvider } from "../lib/runStore";
import { SAMPLE_RESULT } from "../test/fixtures";
import { Workbench } from "./Workbench";

const STAGES = ["ingest", "extract", "normalize", "merge", "confidence", "project", "validate", "emit"];

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streaming /api/runs response, sent in small chunks like a real network. */
function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let runBody: FormData | null = null;

beforeEach(() => {
  sessionStorage.clear();
  runBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/health") {
        return Promise.resolve(Response.json({ ok: true, llmAvailable: false, llmMode: "off", githubToken: false }));
      }
      if (url === "/api/runs") {
        runBody = init?.body as FormData;
        const events =
          STAGES.flatMap((stage) => [sse("stage", { stage, status: "start" }), sse("stage", { stage, status: "done" })]).join("") +
          sse("warning", SAMPLE_RESULT.warnings[0]) +
          sse("result", SAMPLE_RESULT);
        return Promise.resolve(streamResponse(events));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBench() {
  return render(
    <MemoryRouter>
      <RunProvider initial={null}>
        <Workbench />
      </RunProvider>
    </MemoryRouter>,
  );
}

describe("Workbench", () => {
  it("can't run without a CSV, and says the LLM is off on this server", async () => {
    renderBench();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /run pipeline/i }).disabled).toBe(true);
    await waitFor(() => expect(screen.getByText(/Not set up on this server/)).toBeTruthy());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "LLM extraction" }).disabled).toBe(true);
  });

  it("previews the CSV, runs it, streams the log and shows the results", async () => {
    renderBench();
    const csv = new File(
      ["name,email,phone,current_company,title,resume_path\nAnanya Iyer,a@x.com,,Northwind Labs,SBE,resumes/ananya-iyer.pdf\n"],
      "batch.csv",
      { type: "text/csv" },
    );
    fireEvent.change(screen.getByLabelText("Recruiter CSV"), { target: { files: [csv] } });
    await waitFor(() => expect(screen.getByText("1 rows · 6 columns")).toBeTruthy());
    expect(screen.getByText("✗ MISSING")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /run pipeline/i }));

    await waitFor(() => expect(screen.getByRole("link", { name: "Open Ananya Iyer" })).toBeTruthy());
    expect(screen.getByText(/no uploaded file has this name/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("DONE · 1 WARNING");
    expect(screen.getByText("9/10")).toBeTruthy();

    // The request carried the CSV and the chosen options.
    expect(runBody?.get("csv")).toBeInstanceOf(File);
    const options = runBody?.get("options");
    expect(typeof options).toBe("string");
    expect(JSON.parse(options as string)).toMatchObject({ llm: false });

    // The run is kept in this tab for the profile pages.
    expect(sessionStorage.getItem("canonverge.run.v1")).toContain("Ananya Iyer");
  });

  it("flags a CSV that is missing required columns", async () => {
    renderBench();
    const bad = new File(["name,email\nA,a@x.com\n"], "bad.csv");
    fireEvent.change(screen.getByLabelText("Recruiter CSV"), { target: { files: [bad] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("phone, current_company, title"));
  });
});
