import { describe, expect, it } from "vitest";
import { canon, ENTRY_WINDOW, ResumeText } from "../src/adapters/resume-grounding.js";
import { groundExtraction, type ResumeExtraction } from "../src/adapters/resume-llm.js";

const RESUME = `Ananya Iyer
Senior Backend Engineer
EXPERIENCE
Senior Backend Engineer, Northwind Labs
Jan 2022 – Present
Software Engineer, Contoso Retail
Jul 2018 – Dec 2021
EDUCATION
B.Tech in Computer Science, Indian Institute of Technology Madras, 2018
SKILLS
Go, Java, PostgreSQL`;

function extraction(overrides: Partial<ResumeExtraction>): ResumeExtraction {
  return { headline: null, skills: [], experience: [], education: [], ...overrides };
}

describe("canon", () => {
  it("ignores case, spacing, and dash/quote variants from PDF text", () => {
    expect(canon("  Jan 2022 –\n Present ")).toBe("jan 2022 - present");
    expect(canon("Margie’s  Travel")).toBe("margie's travel");
  });
});

describe("ResumeText", () => {
  const resume = new ResumeText(RESUME);

  it("matches whole words only, so a skill can't hide inside another word", () => {
    expect(resume.contains("Go")).toBe(true);
    expect(new ResumeText("Worked at Google").contains("Go")).toBe(false);
  });

  it("finds values regardless of dash style and line breaks", () => {
    expect(resume.contains("Jan 2022 - Present")).toBe(true);
    expect(resume.contains("northwind labs")).toBe(true);
  });

  it("requires an entry's values to sit near each other", () => {
    expect(resume.containsNearby(["Northwind Labs", "Jan 2022"])).toBe(true);
    const far = `Acme Corp\n${"filler ".repeat(ENTRY_WINDOW)}\n2015`;
    expect(new ResumeText(far).containsNearby(["Acme Corp", "2015"])).toBe(false);
  });

  it("rejects an empty anchor list", () => {
    expect(resume.containsNearby([])).toBe(false);
  });
});

describe("groundExtraction", () => {
  it("keeps values that are in the resume, at the LLM's source method", () => {
    const { facts, droppedValues } = groundExtraction(
      extraction({
        headline: "Senior Backend Engineer",
        skills: ["Go", "Java"],
        experience: [
          { company: "Northwind Labs", title: "Senior Backend Engineer", start: "Jan 2022", end: "Present" },
        ],
        education: [
          {
            institution: "Indian Institute of Technology Madras",
            degree: "B.Tech",
            field: "Computer Science",
            end_year: 2018,
          },
        ],
      }),
      RESUME,
      3,
    );

    expect(droppedValues).toBe(0);
    expect(facts.map((fact) => fact.field)).toEqual([
      "headline",
      "skills",
      "skills",
      "experience.entry",
      "education.entry",
    ]);
    expect(facts.every((fact) => fact.source === "resume" && fact.rowIndex === 3)).toBe(true);
    expect(facts.every((fact) => fact.sourceMethod.startsWith("resume_llm:"))).toBe(true);
    expect(facts[4].rawValue).toEqual({
      institution: "Indian Institute of Technology Madras",
      degree: "B.Tech",
      field: "Computer Science",
      end_year: 2018,
    });
  });

  it("drops an invented job, skill and headline entirely", () => {
    const { facts, droppedValues } = groundExtraction(
      extraction({
        headline: "Staff Engineer",
        skills: ["Rust"],
        experience: [{ company: "Globex Corporation", title: "Intern", start: "2017", end: "2017" }],
        education: [{ institution: "MIT", degree: "PhD", field: null, end_year: 2020 }],
      }),
      RESUME,
      0,
    );

    expect(facts).toEqual([]);
    expect(droppedValues).toBe(4);
  });

  it("keeps a real job but blanks a reworded title or a date that isn't there", () => {
    const { facts, droppedValues } = groundExtraction(
      extraction({
        experience: [
          { company: "Contoso Retail", title: "SWE", start: "July 2018", end: "Dec 2021" },
        ],
      }),
      RESUME,
      0,
    );

    expect(droppedValues).toBe(2);
    expect(facts[0].rawValue).toEqual({
      company: "Contoso Retail",
      title: null,
      start: null,
      end: "Dec 2021",
    });
  });

  it("uses the title as the anchor when a job has no company", () => {
    const { facts } = groundExtraction(
      extraction({
        experience: [{ company: null, title: "Software Engineer", start: "Jul 2018", end: null }],
      }),
      RESUME,
      0,
    );
    expect(facts[0].rawValue).toEqual({
      company: null,
      title: "Software Engineer",
      start: "Jul 2018",
      end: null,
    });
  });

  it("blanks a graduation year that is not near the school", () => {
    const { facts, droppedValues } = groundExtraction(
      extraction({
        education: [
          { institution: "Indian Institute of Technology Madras", degree: null, field: null, end_year: 2019 },
        ],
      }),
      RESUME,
      0,
    );
    expect(droppedValues).toBe(1);
    expect(facts[0].rawValue).toMatchObject({ end_year: null });
  });

  it("drops a job with neither company nor title", () => {
    const { facts, droppedValues } = groundExtraction(
      extraction({ experience: [{ company: null, title: null, start: "2018", end: null }] }),
      RESUME,
      0,
    );
    expect(facts).toEqual([]);
    expect(droppedValues).toBe(1);
  });
});
