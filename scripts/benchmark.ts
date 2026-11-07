/**
 * Benchmark: generate synthetic recruiter CSVs, run the full pipeline on each,
 * and report time and peak memory.
 *
 *   npm run benchmark                  # 1k, 10k, 50k rows
 *   npm run benchmark -- 5000 20000    # custom sizes
 *
 * GitHub is mocked with instant responses, so this measures the pipeline
 * itself (parse, normalize, merge, project, validate), not network time.
 * Each size runs in its own child process so peak memory is measured cleanly.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../src/adapters/github.js";
import { runPipeline } from "../src/pipeline.js";
import { DEFAULT_CONFIG } from "../src/schemas/config.js";

const DEFAULT_SIZES = [1_000, 10_000, 50_000];
const SHARE_WITH_GITHUB = 0.2; // 20% of rows name a GitHub username

interface Measurement {
  rows: number;
  githubUsernames: number;
  candidates: number;
  ms: number;
  peakRssMb: number;
}

/** Small seeded random generator, so every run benchmarks the same data. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function generateCsv(rows: number): string {
  const random = seededRandom(42);
  const companies = ["Acme Corp", "Globex", "Initech", "Umbrella", "Hooli"];
  const titles = ["Software Engineer", "Data Analyst", "Product Manager", "SRE"];
  const lines = ["name,email,phone,current_company,title,github_username"];

  for (let i = 0; i < rows; i++) {
    const roll = random();
    // ~5% repeat an earlier person's email (duplicates to merge), ~5% have no email.
    const emailId = roll < 0.05 && i > 0 ? Math.floor(random() * i) : i;
    const email = roll > 0.95 ? "" : `person${emailId}@example.com`;
    // ~10% of phones are garbage and must fail normalization.
    const phone = random() < 0.1 ? "123" : `98${String(10_000_000 + i).slice(-8)}`;
    const github = random() < SHARE_WITH_GITHUB ? `user${i}` : "";
    lines.push(
      [
        `Person ${i}`,
        email,
        phone,
        companies[i % companies.length],
        titles[i % titles.length],
        github,
      ].join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

const mockGitHub: FetchFn = (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = url.includes("/repos")
    ? [{ language: "TypeScript" }, { language: "Go" }, { language: null }]
    : { name: null, bio: "Engineer", html_url: url, location: "Pune, India" };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
};

async function measureOnce(rows: number): Promise<Measurement> {
  const dir = mkdtempSync(join(tmpdir(), "cdt-bench-"));
  const csvPath = join(dir, "candidates.csv");
  writeFileSync(csvPath, generateCsv(rows));

  const started = performance.now();
  const result = await runPipeline({ csvPath, config: DEFAULT_CONFIG, fetch: mockGitHub });
  const ms = performance.now() - started;

  if (!result.ok) {
    throw new Error(result.error);
  }

  return {
    rows,
    githubUsernames: result.stats.githubUsernames,
    candidates: result.stats.candidates,
    ms,
    // maxRSS is in kilobytes and covers the whole process lifetime.
    peakRssMb: process.resourceUsage().maxRSS / 1024,
  };
}

function runInChild(rows: number): Measurement {
  const script = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [...process.execArgv, script, "--child", String(rows)], {
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(`benchmark for ${rows} rows failed:\n${child.stderr}`);
  }
  return JSON.parse(child.stdout) as Measurement;
}

function printTable(results: Measurement[]): void {
  console.log("| CSV rows | GitHub users | Candidates out | Time | Rows/sec | Peak memory |");
  console.log("|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    const rowsPerSec = Math.round(r.rows / (r.ms / 1000)).toLocaleString("en-US");
    console.log(
      `| ${r.rows.toLocaleString("en-US")} | ${r.githubUsernames.toLocaleString("en-US")} | ${r.candidates.toLocaleString("en-US")} | ${(r.ms / 1000).toFixed(2)} s | ${rowsPerSec} | ${Math.round(r.peakRssMb)} MB |`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--child") {
    process.stdout.write(JSON.stringify(await measureOnce(Number(args[1]))));
    return;
  }

  const sizes = args.length > 0 ? args.map(Number) : DEFAULT_SIZES;
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}\n`);
  printTable(sizes.map(runInChild));
}

await main();
