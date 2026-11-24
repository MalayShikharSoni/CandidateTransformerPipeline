// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { RunProvider, type StoredRun } from "../lib/runStore";
import { ANANYA_ID, SAMPLE_RESULT } from "../test/fixtures";
import { Profile } from "./Profile";

afterEach(cleanup);

function renderProfile(path: string, run: StoredRun | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RunProvider initial={run}>
        <Routes>
          <Route path="/profiles/:candidateId" element={<Profile />} />
        </Routes>
      </RunProvider>
    </MemoryRouter>,
  );
}

const RUN: StoredRun = { runNo: 3, finishedAt: "2026-11-24T10:00:00Z", result: SAMPLE_RESULT };

describe("Profile", () => {
  it("shows an empty state when this tab has no run", () => {
    renderProfile(`/profiles/${ANANYA_ID}`, null);
    expect(screen.getByText("No run in this tab.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open the workbench/i }).getAttribute("href")).toBe("/workbench");
  });

  it("renders the candidate from the stored run, with provenance and years", () => {
    renderProfile(`/profiles/${ANANYA_ID}`, RUN);
    expect(screen.getByRole("heading", { level: 1, name: "Ananya Iyer" })).toBeTruthy();
    expect(screen.getByText(/HEADLINE · RESUME · llm_extracted · 0.5/)).toBeTruthy();
    // Years appear in the side stats and in the field table.
    expect(screen.getAllByText("8.4")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Overall confidence 0.74" })).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("selects a timeline job on click without leaving the page", () => {
    renderProfile(`/profiles/${ANANYA_ID}`, RUN);
    const contoso = screen.getByRole("button", { name: "Software Engineer at Contoso Retail" });
    fireEvent.click(contoso);
    expect(contoso.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Software Engineer — Contoso Retail · 2018-07 → 2021-12/)).toBeTruthy();
  });

  it("lists undated jobs honestly instead of inventing dates", () => {
    renderProfile(`/profiles/${"b".repeat(64)}`, RUN);
    expect(screen.getByText(/Support Engineer — Litware Inc · dates not stated/)).toBeTruthy();
  });

  it("says when the candidate is not in the run", () => {
    renderProfile("/profiles/nope", RUN);
    expect(screen.getByText("That candidate isn’t in the latest run.")).toBeTruthy();
  });
});
