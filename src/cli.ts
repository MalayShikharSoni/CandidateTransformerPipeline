import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { readCsvFacts } from "./adapters/csv.js";
import { readGitHubFacts } from "./adapters/github.js";
import { groupFactsByCandidate } from "./merge/group.js";
import { resolveCandidateGroup } from "./merge/resolve.js";
import { normalizeFacts } from "./normalizers/index.js";
import { projectCandidate } from "./projection/project.js";
import { DEFAULT_CONFIG, ProjectionConfig } from "./schemas/config.js";
import { validateProjectedOutput } from "./validate/validate-output.js";

interface CliArgs {
  csvPath: string;
  githubUser: string;
  configPath?: string;
}

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let csvPath: string | undefined;
  let githubUser: string | undefined;
  let configPath: string | undefined;

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

    exitWithError(`Error: unknown argument "${arg}"`);
  }

  if (csvPath === undefined) {
    exitWithError("Error: --csv is required");
  }

  if (githubUser === undefined) {
    exitWithError("Error: --github is required");
  }

  return { csvPath, githubUser, configPath };
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
  const { facts: githubFacts } = await readGitHubFacts(args.githubUser);
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

  console.log(JSON.stringify(output, null, 2));
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
