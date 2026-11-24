import { describe, expect, it } from "vitest";
import { portrait, PORTRAIT_COLS, PORTRAIT_ROWS } from "./portrait";

describe("portrait", () => {
  it("draws a fixed-size frame", () => {
    const lines = portrait(7).split("\n");
    expect(lines).toHaveLength(PORTRAIT_ROWS);
    expect(lines.every((line) => line.length === PORTRAIT_COLS)).toBe(true);
  });

  it("is the same frame for the same tick, and moves between ticks", () => {
    expect(portrait(12)).toBe(portrait(12));
    expect(portrait(12)).not.toBe(portrait(13));
  });

  it("shades a figure with the density ramp and streams source particles", () => {
    const frame = portrait(5);
    expect(frame).toMatch(/[#%@]/);
    expect(frame).toContain("▪");
    expect(frame).toContain("•");
  });

  it("glitches a band of rows on rare ticks only", () => {
    const glitched = portrait(41).split("\n");
    const start = (41 * 7) % PORTRAIT_ROWS;
    expect(glitched[start].startsWith("  ")).toBe(true);
  });
});
