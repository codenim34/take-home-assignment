import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIELDS, validateCandidate } from "@lomi/core";
import { FakeExtractor, PdfParseError, buildPrompt, buildSchema, parsePdf } from "../src/index.js";

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/documents");

describe("parsePdf", () => {
  it("extracts text from every fixture", async () => {
    for (const f of ["invoice-001.pdf", "invoice-001.v2.pdf", "lease-excerpt-001.pdf", "market-report-excerpt-001.pdf"]) {
      const text = await parsePdf(readFileSync(path.join(docs, f)));
      expect(text.length).toBeGreaterThan(200);
    }
  });
  it("turns garbage into a typed parse error", async () => {
    await expect(parsePdf(Buffer.from("not a pdf"))).rejects.toBeInstanceOf(PdfParseError);
  });
});

describe("prompt + schema", () => {
  it("asks for every field of the type, with the document text", () => {
    const p = buildPrompt({ documentType: "lease", fields: FIELDS.lease, text: "DOC" });
    for (const f of FIELDS.lease) expect(p.user).toContain(f.field);
    expect(p.user).toContain("<document>\nDOC\n</document>");
    expect(Object.keys(buildSchema(FIELDS.lease).shape)).toEqual(FIELDS.lease.map((f) => f.field));
  });
});

describe("FakeExtractor", () => {
  it("produces candidates that pass validation for label lines", async () => {
    const text = await parsePdf(readFileSync(path.join(docs, "invoice-001.pdf")));
    const { candidates } = await new FakeExtractor(0).extract({ documentType: "invoice", fields: FIELDS.invoice, text });
    const v = validateCandidate(FIELDS.invoice[2]!, candidates.due_date, text);
    expect(v.value).toBe("2025-10-14");
  });
});
