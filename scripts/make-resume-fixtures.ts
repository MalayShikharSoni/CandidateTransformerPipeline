/**
 * Writes the synthetic resumes in scripts/resume-fixtures-data.ts to
 * fixtures/resumes/ (PDF, DOCX, TXT, MD) plus one answer key per resume in
 * fixtures/resumes/labels/. The output is committed; rerun only after editing
 * the data file:
 *
 *   npx tsx scripts/make-resume-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { fixtureFileName, RESUME_FIXTURES, type ResumeLayout } from "./resume-fixtures-data.js";

const OUT_DIR = "fixtures/resumes";
const LABEL_DIR = join(OUT_DIR, "labels");

const PAGE = { width: 612, height: 792 };
const FONT_SIZE = 10;
const LINE_HEIGHT = 15;
const MARGIN = 50;

async function renderPdf(layout: Extract<ResumeLayout, { kind: "pdf" | "pdf-two-column" }>) {
  const pdf = await PDFDocument.create();
  // Fixed metadata so regenerating gives byte-identical files.
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setProducer("make-resume-fixtures");
  pdf.setCreator("make-resume-fixtures");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const draw = (text: string, x: number, row: number) => {
    if (text !== "") {
      page.drawText(text, { x, y: PAGE.height - MARGIN - row * LINE_HEIGHT, size: FONT_SIZE, font });
    }
  };

  if (layout.kind === "pdf") {
    layout.lines.forEach((line, row) => draw(line, MARGIN, row));
  } else {
    // Left cell then right cell on each row, so text extraction interleaves
    // the two columns the way real sidebar resumes do.
    const rows = Math.max(layout.left.length, layout.right.length);
    for (let row = 0; row < rows; row++) {
      draw(layout.left[row] ?? "", MARGIN, row);
      draw(layout.right[row] ?? "", 230, row);
    }
  }

  return Buffer.from(await pdf.save());
}

async function renderDocx(lines: string[]) {
  const doc = new Document({
    creator: "make-resume-fixtures",
    sections: [{ children: lines.map((line) => new Paragraph({ children: [new TextRun(line)] })) }],
  });
  return Packer.toBuffer(doc);
}

async function main() {
  mkdirSync(LABEL_DIR, { recursive: true });

  for (const fixture of RESUME_FIXTURES) {
    const file = join(OUT_DIR, fixtureFileName(fixture));
    const { layout } = fixture;

    if (layout.kind === "pdf" || layout.kind === "pdf-two-column") {
      writeFileSync(file, await renderPdf(layout));
    } else if (layout.kind === "docx") {
      writeFileSync(file, await renderDocx(layout.lines));
    } else {
      writeFileSync(file, `${layout.lines.join("\n")}\n`, "utf8");
    }

    writeFileSync(
      join(LABEL_DIR, `${fixture.name}.json`),
      `${JSON.stringify({ file: fixtureFileName(fixture), ...fixture.truth }, null, 2)}\n`,
      "utf8",
    );
    console.log(`wrote ${file}`);
  }
}

await main();
