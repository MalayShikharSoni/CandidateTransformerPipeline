import { describe, expect, it } from "vitest";
import { normalizeCountry } from "../src/normalizers/country.js";
import { normalizeDate } from "../src/normalizers/date.js";
import { normalizeFacts } from "../src/normalizers/index.js";
import { normalizePhone } from "../src/normalizers/phone.js";
import { normalizeSkill } from "../src/normalizers/skills.js";

describe("normalizePhone", () => {
  it.each([
    ["+91 98765 43210", "+919876543210"],
    ["9876543299", "+919876543299"], // no country code: default IN
    ["+1 (415) 555-2671", "+14155552671"],
    ["  +919812345678  ", "+919812345678"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("uses the given default country for numbers without a code", () => {
    expect(normalizePhone("(415) 555-2671", { defaultCountry: "US" })).toBe("+14155552671");
  });

  it.each(["123", "", "   ", "not a phone", "+91 12"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizePhone(9876543210)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizeDate", () => {
  it.each([
    ["2024-03", "2024-03"],
    ["2024-03-15", "2024-03"],
    ["2024/03", "2024-03"],
    ["03/2024", "2024-03"],
    ["2024", "2024-01"],
    ["2024-03-15T10:00:00Z", "2024-03"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it.each(["2024-13", "2023-02-30", "present", "Current", "March 2024", "", 2024])(
    "returns null for %j",
    (input) => {
      expect(normalizeDate(input)).toBeNull();
    },
  );
});

describe("normalizeCountry", () => {
  it.each([
    ["India", "IN"],
    ["in", "IN"],
    ["Punjab", "IN"],
    ["USA", "US"],
    ["United Kingdom", "GB"],
    ["de", "DE"],
    ["NZ", "NZ"], // any two letters pass through as an ISO code
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCountry(input)).toBe(expected);
  });

  it.each(["Atlantis", "", "Republic of Nowhere", 42])("returns null for %j", (input) => {
    expect(normalizeCountry(input)).toBeNull();
  });
});

describe("normalizeSkill", () => {
  it.each([
    ["js", "JavaScript"],
    ["Java Script", "JavaScript"],
    ["TS", "TypeScript"],
    ["nodejs", "Node.js"],
    ["  postgres ", "PostgreSQL"],
    ["Rust", "Rust"], // unknown skills pass through unchanged
  ])("%s -> %s", (input, expected) => {
    expect(normalizeSkill(input)).toBe(expected);
  });

  it("returns null for empty or non-string input", () => {
    expect(normalizeSkill("  ")).toBeNull();
    expect(normalizeSkill(undefined)).toBeNull();
  });
});

describe("normalizeFacts", () => {
  const base = { source: "csv" as const, sourceMethod: "test", rowIndex: 0 };

  it("runs the field's normalizer and records whether it succeeded", () => {
    const [good, bad] = normalizeFacts([
      { ...base, field: "phones", rawValue: "+91 98765 43210" },
      { ...base, field: "phones", rawValue: "123" },
    ]);

    expect(good).toMatchObject({ normalizedValue: "+919876543210", normalizationSucceeded: true });
    expect(bad).toMatchObject({ normalizedValue: null, normalizationSucceeded: false });
  });

  it("passes through known fields unchanged", () => {
    const [name] = normalizeFacts([{ ...base, field: "full_name", rawValue: "Aditi Rao" }]);
    expect(name).toMatchObject({ normalizedValue: "Aditi Rao", normalizationSucceeded: true });
  });

  it("marks fields with no normalizer and no passthrough as not normalized", () => {
    const [unknown] = normalizeFacts([{ ...base, field: "mystery", rawValue: "x" }]);
    expect(unknown.normalizationSucceeded).toBe(false);
  });
});
