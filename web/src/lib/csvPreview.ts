/**
 * Reads just enough of a CSV in the browser to preview it before a run:
 * the header, the row count and the resume_path values. Quoted fields and
 * escaped quotes ("") are handled; the server does the real parsing.
 */
export interface CsvPreview {
  columns: string[];
  rows: number;
  resumePaths: string[];
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function previewCsv(text: string): CsvPreview {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return { columns: [], rows: 0, resumePaths: [] };

  const columns = parseLine(lines[0]);
  const resumeIndex = columns.indexOf("resume_path");
  const resumePaths =
    resumeIndex === -1
      ? []
      : lines
          .slice(1)
          .map((line) => parseLine(line)[resumeIndex] ?? "")
          .filter((path) => path !== "");
  return { columns, rows: lines.length - 1, resumePaths };
}

/** The file-name part of a path, lower-cased, the way the server matches uploads. */
export function uploadKey(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/[^A-Za-z0-9._-]/g, "_").toLowerCase();
}

export const REQUIRED_COLUMNS = ["name", "email", "phone", "current_company", "title"];
