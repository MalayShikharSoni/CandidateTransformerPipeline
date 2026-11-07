#!/usr/bin/env node
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FileResponseCache } from "./adapters/github-cache.js";
import { resolveToken } from "./adapters/github.js";
import { createLogger, type LogFormat, type Logger } from "./log.js";
import { runPipeline, type OutputRecord } from "./pipeline.js";
import { DEFAULT_CONFIG, ProjectionConfig } from "./schemas/config.js";

/** Exit codes: 0 success, 1 setup error, 2 a source failed and --strict was set. */
const EXIT_OK = 0;
const EXIT_SETUP_ERROR = 1;
const EXIT_SOURCE_WARNINGS = 2;

const DEFAULT_CACHE_DIR = ".cache/github";

const HELP = `Usage: candidate-transformer --csv <path> [options]

Merge a recruiter CSV with GitHub profiles into one canonical JSON profile per candidate.

Options:
  --csv <path>          Recruiter CSV (required)
  --github <username>   Use this GitHub username for every row
                        (default: each row's github_username column)
  --config <path>       ProjectionConfig JSON (default: full canonical schema)
  --output <path>       Write output to a file instead of stdout
  --format <json|ndjson>  JSON array (default) or one JSON object per line
  --strict              Exit with code 2 if any GitHub call failed
  --cache-dir <path>    Where to keep GitHub ETag cache (default: ${DEFAULT_CACHE_DIR})
  --no-cache            Don't read or write the GitHub cache
  --log-format <text|json>  Format of stderr messages (default: text)
  -h, --help            Show this help

Exit codes: 0 ok, 1 setup error, 2 --strict and a source failed.
Set GITHUB_TOKEN (or GH_TOKEN) in the environment or .env for 5,000 GitHub requests/hour.`;

type OutputFormat = "json" | "ndjson";

interface CliArgs {
  help: boolean;
  csvPath?: string;
  githubUser?: string;
  configPath?: string;
  outputPath?: string;
  format: OutputFormat;
  strict: boolean;
  /** undefined when --no-cache is set */
  cacheDir?: string;
  logFormat: LogFormat;
}

/** A problem with how the CLI was called or set up; reported, then exit 1. */
class SetupError extends Error {}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new SetupError(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
}

function parseCliArgs(argv: string[]): CliArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        csv: { type: "string" },
        github: { type: "string" },
        config: { type: "string" },
        output: { type: "string" },
        format: { type: "string", default: "json" },
        strict: { type: "boolean", default: false },
        "cache-dir": { type: "string", default: DEFAULT_CACHE_DIR },
        "no-cache": { type: "boolean", default: false },
        "log-format": { type: "string", default: "text" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SetupError(`${message}\nRun with --help to see the options.`);
  }

  return {
    help: values.help,
    csvPath: values.csv,
    githubUser: values.github,
    configPath: values.config,
    outputPath: values.output,
    format: oneOf(values.format, ["json", "ndjson"], "--format"),
    strict: values.strict,
    cacheDir: values["no-cache"] ? undefined : values["cache-dir"],
    logFormat: oneOf(values["log-format"], ["text", "json"], "--log-format"),
  };
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
    throw new SetupError(`cannot read config file: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SetupError(`config file is not valid JSON: ${message}`);
  }

  const result = ProjectionConfig.safeParse(parsed);
  if (!result.success) {
    throw new SetupError(`invalid ProjectionConfig: ${result.error.message}`);
  }

  return result.data;
}

function formatOutput(records: OutputRecord[], format: OutputFormat): string {
  if (format === "ndjson") {
    return records.map((record) => `${JSON.stringify(record)}\n`).join("");
  }
  return `${JSON.stringify(records, null, 2)}\n`;
}

async function writeOutput(text: string, outputPath?: string): Promise<void> {
  if (outputPath === undefined) {
    process.stdout.write(text);
    return;
  }
  try {
    await writeFile(outputPath, text, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SetupError(`cannot write output file: ${message}`);
  }
}

async function run(args: CliArgs, log: Logger): Promise<number> {
  if (args.csvPath === undefined) {
    throw new SetupError("--csv is required. Run with --help to see the options.");
  }

  const config = await loadConfig(args.configPath);
  const started = performance.now();

  const result = await runPipeline({
    csvPath: args.csvPath,
    config,
    githubUser: args.githubUser,
    cache: args.cacheDir === undefined ? undefined : new FileResponseCache(args.cacheDir),
  });
  if (!result.ok) {
    throw new SetupError(result.error);
  }

  if (result.stats.githubUsernames > 0 && resolveToken() === undefined) {
    log.note("no GITHUB_TOKEN set, so GitHub allows only 60 requests/hour (2 per candidate).");
  }
  for (const warning of result.warnings) {
    log.warning(warning);
  }

  await writeOutput(formatOutput(result.records, args.format), args.outputPath);
  log.summary(result.stats, performance.now() - started);

  if (args.strict && result.warnings.length > 0) {
    log.error(`--strict: ${result.warnings.length} source warning(s), exiting with code 2.`);
    return EXIT_SOURCE_WARNINGS;
  }
  return EXIT_OK;
}

async function main(): Promise<number> {
  let log = createLogger("text");
  try {
    const args = parseCliArgs(process.argv.slice(2));
    log = createLogger(args.logFormat);
    if (args.help) {
      process.stdout.write(`${HELP}\n`);
      return EXIT_OK;
    }
    return await run(args, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(error instanceof SetupError ? message : `unexpected failure: ${message}`);
    return EXIT_SETUP_ERROR;
  }
}

// Set exitCode instead of calling process.exit(), so a large output piped to
// another program is fully flushed before Node exits. main() catches its own
// errors, so `void` here only marks that nothing awaits the top-level call.
void main().then((code) => {
  process.exitCode = code;
});
