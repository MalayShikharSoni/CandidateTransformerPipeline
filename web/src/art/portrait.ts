/**
 * The hero's ASCII figure: a head-and-shoulders silhouette shaded with a
 * density ramp, a 0/1 scanline sweeping down it, and particles streaming in
 * from the three source tags. Pure: the same tick always gives the same frame,
 * except for the rare one-frame glitch, which is also derived from the tick.
 */

export const PORTRAIT_COLS = 78;
export const PORTRAIT_ROWS = 50;

const RAMP = " .:-=+*#%@";

function hash(x: number, y: number, t: number): number {
  let n = (x * 374761393 + y * 668265263 + t * 1442695041) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function portrait(tick: number): string {
  const W = PORTRAIT_COLS;
  const H = PORTRAIT_ROWS;
  const grid: string[][] = [];
  // Characters are ~0.65 as wide as tall, so x is scaled to keep the head round.
  const cx = 25.4;
  const hx = 24.6;
  const hy = 18;
  const rx = 8.6;
  const ry = 10.6;
  const scan = tick % (H + 14);

  for (let y = 0; y < H; y++) {
    const row: string[] = [];
    for (let x = 0; x < W; x++) {
      const px = x * 0.65;
      const py = y;
      const e = ((px - hx) / rx) ** 2 + ((py - hy) / ry) ** 2;
      const head = e < 1;
      const neck = Math.abs(px - cx) < 4 && py > 26 && py < 33;
      const half = Math.min(22, 6 + (py - 31) * 1.9);
      const body = py >= 31 && Math.abs(px - cx) < half;
      let ch = " ";
      if (head || neck || body) {
        // Light from the upper left, a little grain, darker rims.
        const light = 0.55 - 0.5 * ((px - cx) / 22) - 0.2 * ((py - 25) / 25);
        let d = 1 - light + (hash(x, y, Math.floor(tick / 3)) - 0.5) * 0.22;
        if (head && e > 0.82) d += 0.35;
        if (body && Math.abs(px - cx) > half - 1.2) d += 0.3;
        d = Math.max(0, Math.min(0.999, d));
        ch = RAMP[Math.floor(d * RAMP.length)];
        if (y === scan || y === scan - 1) ch = hash(x, y, tick) > 0.5 ? "1" : "0";
      } else if (x % 6 === 0 && y % 4 === 0) {
        ch = "·";
      } else if (hash(x, y, Math.floor(tick / 9)) > 0.996) {
        ch = "+";
      }
      row.push(ch);
    }
    grid.push(row);
  }

  // One glyph per source, flowing from its tag's corner into the head.
  const target: [number, number] = [38, 18];
  const origins: Array<[number, number]> = [
    [3, 4],
    [3, H - 6],
    [W - 4, H - 6],
  ];
  const glyphs = ["▪", "•", "▫"];
  origins.forEach(([ox, oy], s) => {
    for (let k = 0; k < 7; k++) {
      const p = (k / 7 + tick * 0.012 + s * 0.11) % 1;
      const gx = Math.round(ox + (target[0] - ox) * p);
      const gy = Math.round(oy + (target[1] - oy) * p);
      if (p < 0.82 && gy >= 0 && gy < H && gx >= 0 && gx < W) grid[gy][gx] = glyphs[s];
    }
  });

  const lines = grid.map((row) => row.join(""));
  // Rare glitch: three rows slip two characters for one frame.
  if (tick > 0 && tick % 41 === 0) {
    const start = (tick * 7) % H;
    for (let g = start; g < Math.min(H, start + 3); g++) lines[g] = `  ${lines[g].slice(0, W - 2)}`;
  }
  return lines.join("\n");
}
