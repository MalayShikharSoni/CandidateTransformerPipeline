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
}

function hasRequiredColumns(row: Record<string, unknown>): row is CsvRow {
  return REQUIRED_COLUMNS.every((column) => column in row);
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
  } catch {
    return { facts: [] };
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
        if (!hasRequiredColumns(record as Record<string, unknown>)) {
          return { facts: [] };
        }
        headerValidated = true;
      }

      try {
        facts.push(...rowToFacts(record as CsvRow, rowIndex));
        rowIndex++;
      } catch {
        continue;
      }
    }

    return { facts };
  } catch {
    return { facts: [] };
  }
}

