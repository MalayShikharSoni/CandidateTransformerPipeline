import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { parse } from "csv-parse";
import type { RawFact } from "../schemas/raw-fact.js";

const REQUIRED_COLUMNS = [
  "name",
  "email",
  "phone",
  "current_company",
  "title",
] as const;

const OPTIONAL_COLUMNS = ["github_username"] as const;

type CsvRow = Record<(typeof REQUIRED_COLUMNS)[number], string | undefined> &
  Partial<Record<(typeof OPTIONAL_COLUMNS)[number], string | undefined>>;

export interface CsvAdapterResult {
  facts: RawFact[];
  /**
   * Set when the CSV can't be used at all (missing file, missing columns,
   * unparseable). The CSV is the run's main input, so the CLI treats this as a
   * setup error instead of quietly printing [].
   */
  error?: string;
}

function missingColumns(row: Record<string, unknown>): string[] {
  return REQUIRED_COLUMNS.filter((column) => !(column in row));
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function rowToFacts(row: CsvRow, rowIndex: number): RawFact[] {
  const facts: RawFact[] = [];

  const name = nonEmpty(row.name);
  if (name !== undefined) {
    facts.push({
      field: "full_name",
      rawValue: name,
      source: "csv",
      sourceMethod: "csv_column:name",
      rowIndex,
    });
  }

  const email = nonEmpty(row.email);
  if (email !== undefined) {
    facts.push({
      field: "emails",
      rawValue: email,
      source: "csv",
      sourceMethod: "csv_column:email",
      rowIndex,
    });
  }

  const phone = nonEmpty(row.phone);
  if (phone !== undefined) {
    facts.push({
      field: "phones",
      rawValue: phone,
      source: "csv",
      sourceMethod: "csv_column:phone",
      rowIndex,
    });
  }

  const company = nonEmpty(row.current_company);
  if (company !== undefined) {
    facts.push({
      field: "experience.company",
      rawValue: company,
      source: "csv",
      sourceMethod: "csv_column:current_company",
      rowIndex,
    });
  }

  const title = nonEmpty(row.title);
  if (title !== undefined) {
    facts.push({
      field: "experience.title",
      rawValue: title,
      source: "csv",
      sourceMethod: "csv_column:title",
      rowIndex,
    });
  }

  const githubUsername = nonEmpty(row.github_username);
  if (githubUsername !== undefined) {
    facts.push({
      field: "links.github_username",
      rawValue: githubUsername,
      source: "csv",
      sourceMethod: "csv_column:github_username",
      rowIndex,
    });
  }

  return facts;
}

export async function readCsvFacts(filePath: string): Promise<CsvAdapterResult> {
  try {
    await access(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { facts: [], error: `cannot read CSV file: ${message}` };
  }

  try {
    const facts: RawFact[] = [];
    let headerValidated = false;

    const stream = createReadStream(filePath);
    const parser = stream.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }),
    );

    let rowIndex = 0;

    for await (const record of parser) {
      if (!record || typeof record !== "object") {
        continue;
      }

      if (!headerValidated) {
        const missing = missingColumns(record as Record<string, unknown>);
        if (missing.length > 0) {
          return {
            facts: [],
            error: `CSV is missing required column(s): ${missing.join(", ")}`,
          };
        }
        headerValidated = true;
      }

      facts.push(...rowToFacts(record as CsvRow, rowIndex));
      rowIndex++;
    }

    return { facts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { facts: [], error: `cannot parse CSV file: ${message}` };
  }
}

