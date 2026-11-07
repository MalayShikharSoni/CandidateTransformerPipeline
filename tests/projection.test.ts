import { describe, expect, it } from "vitest";
import { parseFromPath, projectCandidate } from "../src/projection/project.js";
import type { CanonicalCandidate } from "../src/schemas/canonical.js";
import { ProjectionConfig, type FieldConfig } from "../src/schemas/config.js";
import { buildOutputSchema, validateProjectedOutput } from "../src/validate/validate-output.js";

const candidate: CanonicalCandidate = {
  candidate_id: "abc",
  full_name: "Aditi Rao",
  emails: ["aditi.rao@example.com", "aditi@work.example"],
  phones: ["+919876543299"],
  location: { city: "Pune", region: null, country: "IN" },
  links: { linkedin: null, github: "https://github.com/aditi", portfolio: null, other: [] },
  headline: null,
  years_experience: null,
  skills: [
    { name: "TypeScript", confidence: 0.9, sources: ["csv"] },
    { name: "js", confidence: 0.6, sources: ["github"] },
  ],
  experience: [{ company: "Acme Corp", title: "Software Engineer", start: null, end: null, summary: null }],
  education: [],
  provenance: [
    { field: "full_name", source: "csv", method: "direct" },
    { field: "emails", source: "csv", method: "direct" },
    { field: "links.github", source: "github", method: "direct" },
    { field: "phones", source: "csv", method: "normalized" },
  ],
  overall_confidence: 0.8,
};

function field(overrides: Partial<FieldConfig> & Pick<FieldConfig, "path" | "from" | "type">): FieldConfig {
  return { required: false, normalize: "none", ...overrides };
}

function config(fields: FieldConfig[], extra: Partial<ProjectionConfig> = {}): ProjectionConfig {
  return { fields, include_confidence: false, on_missing: "null", ...extra };
}

describe("parseFromPath", () => {
  it("parses props, indexes and a wildcard", () => {
    expect(parseFromPath("location.city")).toEqual([
      { kind: "prop", key: "location" },
      { kind: "prop", key: "city" },
    ]);
    expect(parseFromPath("emails[0]")).toEqual([
      { kind: "prop", key: "emails" },
      { kind: "index", index: 0 },
    ]);
    expect(parseFromPath("skills[].name")).toEqual([
      { kind: "prop", key: "skills" },
      { kind: "wildcard" },
      { kind: "prop", key: "name" },
    ]);
  });

  it.each(["", "emails[x]", "a..b", "skills[].tags[].name"])("rejects %j", (path) => {
    expect(parseFromPath(path)).toHaveProperty("error");
  });
});

describe("projectCandidate", () => {
  it("renames, indexes into arrays and maps wildcards", () => {
    const out = projectCandidate(
      candidate,
      config([
        field({ path: "primary_email", from: "emails[0]", type: "string" }),
        field({ path: "city", from: "location.city", type: "string" }),
        field({ path: "skill_names", from: "skills[].name", type: "string[]" }),
      ]),
    );

    expect(out).toEqual({
      primary_email: "aditi.rao@example.com",
      city: "Pune",
      skill_names: ["TypeScript", "js"],
    });
  });

  it("applies a per-field normalize override", () => {
    const out = projectCandidate(
      candidate,
      config([field({ path: "skills", from: "skills[].name", type: "string[]", normalize: "canonical" })]),
    );
    expect(out).toEqual({ skills: ["TypeScript", "JavaScript"] });
  });

  it("handles missing values according to on_missing", () => {
    const missing = [field({ path: "third_email", from: "emails[2]", type: "string", required: true })];

    expect(projectCandidate(candidate, config(missing))).toEqual({ third_email: null });
    expect(projectCandidate(candidate, config(missing, { on_missing: "omit" }))).toEqual({});
    expect(projectCandidate(candidate, config(missing, { on_missing: "error" }))).toHaveProperty("error");
  });

  it("treats a value of the wrong type as missing", () => {
    const out = projectCandidate(candidate, config([field({ path: "name", from: "full_name", type: "number" })]));
    expect(out).toEqual({ name: null });
  });

  it("includes only provenance for the fields that were requested", () => {
    const out = projectCandidate(
      candidate,
      config([field({ path: "github", from: "links.github", type: "string" })], { include_confidence: true }),
    );

    expect(out).toMatchObject({
      github: "https://github.com/aditi",
      overall_confidence: 0.8,
      provenance: [{ field: "links.github", source: "github", method: "direct" }],
    });
  });

  it("does not change the canonical record", () => {
    const before = structuredClone(candidate);
    projectCandidate(candidate, config([field({ path: "skills", from: "skills[].name", type: "string[]", normalize: "canonical" })]));
    expect(candidate).toEqual(before);
  });
});

describe("output validation", () => {
  const nameOnly = config([field({ path: "full_name", from: "full_name", type: "string" })]);

  it("rejects keys the config didn't ask for", () => {
    expect(validateProjectedOutput({ full_name: "A", extra: 1 }, nameOnly).ok).toBe(false);
  });

  it("allows null under on_missing null and absence under omit", () => {
    expect(validateProjectedOutput({ full_name: null }, nameOnly).ok).toBe(true);
    expect(validateProjectedOutput({}, { ...nameOnly, on_missing: "omit" }).ok).toBe(true);
  });

  it("checks object[] fields against the canonical schema", () => {
    const skills = config([field({ path: "skills", from: "skills", type: "object[]" })]);
    expect(validateProjectedOutput({ skills: candidate.skills }, skills).ok).toBe(true);
    expect(validateProjectedOutput({ skills: [{ name: "Go" }] }, skills).ok).toBe(false);
  });

  it("uses the canonical schema by `from`, even when the output is renamed", () => {
    const schema = buildOutputSchema(config([field({ path: "my_links", from: "links", type: "object" })]));
    expect(schema.safeParse({ my_links: { anything: true } }).success).toBe(false);
    expect(schema.safeParse({ my_links: candidate.links }).success).toBe(true);
  });

  it("falls back to a plain object check for nested paths", () => {
    const schema = buildOutputSchema(config([field({ path: "job", from: "experience[0]", type: "object" })]));
    expect(schema.safeParse({ job: { anything: true } }).success).toBe(true);
    expect(schema.safeParse({ job: "not an object" }).success).toBe(false);
  });

  it("parses a config file shape and fills defaults", () => {
    const parsed = ProjectionConfig.parse({ fields: [{ path: "x", from: "full_name", type: "string" }] });
    expect(parsed).toEqual({
      fields: [{ path: "x", from: "full_name", type: "string", required: false, normalize: "none" }],
      include_confidence: false,
      on_missing: "null",
    });
  });
});
