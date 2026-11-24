import { describe, expect, it } from "vitest";
import { previewCsv, uploadKey } from "./csvPreview";

describe("previewCsv", () => {
  it("reads the header, counts rows and lists resume paths", () => {
    const csv = "\uFEFFname,email,resume_path\r\nA,a@x.com,resumes/a.pdf\r\n\"B, Jr.\",b@x.com,\r\nC,\"c\"\"q@x.com\",cv/C.docx\r\n";
    expect(previewCsv(csv)).toEqual({
      columns: ["name", "email", "resume_path"],
      rows: 3,
      resumePaths: ["resumes/a.pdf", "cv/C.docx"],
    });
  });

  it("copes with an empty file and a CSV without resume_path", () => {
    expect(previewCsv("")).toEqual({ columns: [], rows: 0, resumePaths: [] });
    expect(previewCsv("name,email\nA,a@x.com\n").resumePaths).toEqual([]);
  });
});

describe("uploadKey", () => {
  it("matches the server's rule: file name only, lower case, safe characters", () => {
    expect(uploadKey("resumes/Ananya-Iyer.PDF")).toBe("ananya-iyer.pdf");
    expect(uploadKey("C:\\cv\\My CV.pdf")).toBe("my_cv.pdf");
    expect(uploadKey("../../etc/passwd")).toBe("passwd");
  });
});
