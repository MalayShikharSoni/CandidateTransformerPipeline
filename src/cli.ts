import "dotenv/config";
import { access, readFile, writeFile } from "node:fs/promises";
import pLimit from "p-limit";
import { readCsvFacts } from "./adapters/csv.js";
import { readGitHubFacts } from "./adapters/github.js";
import { groupFactsByCandidate } from "./merge/group.js";
import { resolveCandidateGroup } from "./merge/resolve.js";
import { normalizeFacts } from "./normalizers/index.js";
import { projectCandidate } from "./projection/project.js";
import { DEFAULT_CONFIG, ProjectionConfig } from "./schemas/config.js";
import type { RawFact } from "./schemas/raw-fact.js";
import { validateProjectedOutput } from "./validate/validate-output.js";

interface CliArgs {
  csvPath: string;
  githubUser?: string;
  configPath?: string;
  outputPath?: string;
}

interface FetchJob {
  rowIndex: number;
  username: string;
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let csvPath: string | undefined;
  let githubUser: string | undefined;
  let configPath: string | undefined;
  let outputPath: string | undefined;

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--csv") {
      const value = argv[++index];
      if (value === undefined) {
        exitWithError("Error: --csv requires a path argument");
      }
      csvPath = value;
      continue;
    }

    if (arg === "--github") {
      const value = argv[++index];
      if (value === undefined) {
        exitWithError("Error: --github requires a username argument");
      }
      githubUser = value;
      continue;
    }

    if (arg === "--config") {
      const value = argv[++index];
      if (value === undefined) {
        exitWithError("Error: --config requires a path argument");
      }
      configPath = value;
      continue;
    }

    if (arg === "--output") {
      const value = argv[++index];
      if (value === undefined) {
        exitWithError("Error: --output requires a path argument");
      }
      outputPath = value;
      continue;
    }

    exitWithError(`Error: unknown argument "${arg}"`);
  }

  if (csvPath === undefined) {
    exitWithError("Error: --csv is required");
  }

  return { csvPath, githubUser, configPath, outputPath };
}

function bucketCsvFactsByRow(facts: RawFact[]): Map<number, RawFact[]> {
  const buckets = new Map<number, RawFact[]>();

  for (const fact of facts) {
    if (fact.source !== "csv") {
      continue;
    }

    const bucket = buckets.get(fact.rowIndex);
    if (bucket === undefined) {
      buckets.set(fact.rowIndex, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  return buckets;
}

function githubUsernameFromRow(rowFacts: RawFact[]): string | undefined {
  for (const fact of rowFacts) {
    if (fact.field !== "links.github_username") {
      continue;
    }

    if (typeof fact.rawValue === "string") {
      const trimmed = fact.rawValue.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }

  return undefined;
}

function buildFetchJobs(
  rowBuckets: Map<number, RawFact[]>,
  globalGithubUser?: string,
): FetchJob[] {
  const jobs: FetchJob[] = [];

  for (const [rowIndex, rowFacts] of rowBuckets) {
    const username = globalGithubUser ?? githubUsernameFromRow(rowFacts);
    if (username === undefined) {
      continue;
    }

    jobs.push({ rowIndex, username });
  }

  return jobs;
}

async function fetchGitHubFactsForJobs(jobs: FetchJob[]): Promise<RawFact[]> {
  const uniqueUsernames = [...new Set(jobs.map((job) => job.username))];
  const limit = pLimit(10);
  const factsByUsername = new Map<string, RawFact[]>();

  await Promise.all(
    uniqueUsernames.map((username) =>
      limit(async () => {
        const { facts } = await readGitHubFacts(username);
        factsByUsername.set(username, facts);
      }),
    ),
  );

  const githubFacts: RawFact[] = [];

  for (const { rowIndex, username } of jobs) {
    const fetched = factsByUsername.get(username) ?? [];
    for (const fact of fetched) {
      githubFacts.push({ ...fact, rowIndex });
    }
  }

  return githubFacts;
}

async function loadConfig(configPath?: string): Promise<ProjectionConfig> {
  if (configPath === undefined) {
    return DEFAULT_CONFIG;
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(`Error: cannot read config file: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(`Error: config file is not valid JSON: ${message}`);
  }

  const result = ProjectionConfig.safeParse(parsed);
  if (!result.success) {
    exitWithError(`Error: invalid ProjectionConfig: ${result.error.message}`);
  }

  return result.data;
}

async function assertCsvReadable(csvPath: string): Promise<void> {
  try {
    await access(csvPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(`Error: cannot read CSV file: ${message}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.configPath);
  await assertCsvReadable(args.csvPath);

  const { facts: csvFacts } = await readCsvFacts(args.csvPath);
  const rowBuckets = bucketCsvFactsByRow(csvFacts);
  const fetchJobs = buildFetchJobs(rowBuckets, args.githubUser);
  const githubFacts =
    fetchJobs.length > 0 ? await fetchGitHubFactsForJobs(fetchJobs) : [];

  const groups = groupFactsByCandidate(
    normalizeFacts([...csvFacts, ...githubFacts]),
  );

  const output = groups.map((group) => {
    const canonical = resolveCandidateGroup(group);
    const projected = projectCandidate(canonical, config);

    if ("error" in projected) {
      return { error: projected.error };
    }

    const validated = validateProjectedOutput(projected, config);
    if (!validated.ok) {
      return { error: validated.error };
    }

    return validated.data;
  });

  const json = JSON.stringify(output, null, 2);

  if (args.outputPath !== undefined) {
    try {
      await writeFile(args.outputPath, `${json}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(`Error: cannot write output file: ${message}`);
    }
  } else {
    console.log(json);
  }

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: unexpected failure: ${message}`);
    process.exit(1);
  });
