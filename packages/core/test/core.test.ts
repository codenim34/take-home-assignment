import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import {
  FIELDS,
  compareForCarryOver,
  fieldType,
  findEvidence,
  validateCandidate,
  type FieldDef,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../../fixtures");

async function pdfText(file: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path.join(fixtures, "documents", file))));
  return (await extractText(pdf, { mergePages: true })).text;
}

const def = (field: string): FieldDef => FIELDS.invoice.find((f) => f.field === field)!;

describe("field definitions", () => {
  it("match fixtures/expected-fields.json", () => {
    const expected = JSON.parse(readFileSync(path.join(fixtures, "expected-fields.json"), "utf8"));
    expect(FIELDS).toEqual(expected);
  });
});

describe("field types", () => {
  it.each([
    ["date", "2025-09-14", "2025-09-14"],
    ["date", "March 1, 2025", "2025-03-01"],
    ["date", "1 March 2025", "2025-03-01"],
    ["date", "03/01/2025", "2025-03-01"],
    ["date", "2025-02-30", null],
    ["money", "$5,230.29", "5230.29"],
    ["money", "5230.3", "5230.30"],
    ["money", "USD 1,985", "1985.00"],
    ["money", "about five", null],
    ["percent", "4.2%", "4.2"],
    ["number", "24", "24"],
    ["string", "  INV-2025-0847 ", "INV-2025-0847"],
  ] as const)("%s %j -> %j", (type, raw, expected) => {
    expect(fieldType(type).normalize(raw)).toBe(expected);
  });

  it("checks the value is stated in the quote", () => {
    expect(fieldType("money").isStatedIn("5230.29", "Total Due: $5,230.29")).toBe(true);
    expect(fieldType("money").isStatedIn("4815.00", "Total Due: $5,230.29")).toBe(false);
    expect(fieldType("number").isStatedIn("24", "twenty-four (24) months")).toBe(true);
    expect(fieldType("date").isStatedIn("2025-03-01", "commencing on March 1, 2025")).toBe(true);
  });

  it("compares strings case-insensitively and everything else canonically", () => {
    expect(fieldType("string").equals("Meridian LLC", "MERIDIAN LLC")).toBe(true);
    expect(fieldType("money").equals("5230.29", "5230.30")).toBe(false);
  });

  it("gives every type a prompt hint", () => {
    for (const t of ["string", "date", "money", "number", "percent"] as const) expect(fieldType(t).promptHint).toBeTruthy();
  });
});

describe("findEvidence", () => {
  const text = "Line one\nTotal Due:      $5,230.29\nend";
  it("finds exact substrings with offsets", () => {
    const m = findEvidence(text, "Line one")!;
    expect(m).toMatchObject({ start: 0, end: 8, matchKind: "exact" });
  });
  it("tolerates whitespace differences only, mapping offsets to the original", () => {
    const m = findEvidence(text, "Total Due: $5,230.29")!;
    expect(m.matchKind).toBe("whitespace");
    expect(text.slice(m.start, m.end)).toBe("Total Due:      $5,230.29");
    expect(findEvidence(text, "one Total")).toMatchObject({ matchKind: "whitespace" });
  });
  it("rejects anything else", () => {
    expect(findEvidence(text, "Total due: $5,230.29")).toBeNull(); // case differs
    expect(findEvidence(text, "Total Due: $5230.29")).toBeNull();
    expect(findEvidence(text, "   ")).toBeNull();
  });
});

describe("validateCandidate (hallucination defense)", () => {
  let text: string;
  beforeAll(async () => {
    text = await pdfText("invoice-001.pdf");
  });

  it("keeps a value whose quote is verbatim and states the value", () => {
    const v = validateCandidate(def("total_amount"), { value: "5230.29", evidence: "Total Due: $5,230.29" }, text);
    expect(v).toMatchObject({ value: "5230.29", gapReason: null, evidence: "Total Due: $5,230.29" });
    expect(text.slice(v.evidenceStart!, v.evidenceEnd!)).toBe("Total Due: $5,230.29");
  });

  it("turns a fabricated quote into a gap", () => {
    const v = validateCandidate(def("total_amount"), { value: "5230.29", evidence: "Amount payable: $5,230.29" }, text);
    expect(v.value).toBeNull();
    expect(v.evidence).toBeNull();
    expect(v.gapReason).toMatch(/does not appear/);
  });

  it("turns a real quote with an invented value into a gap", () => {
    const v = validateCandidate(def("total_amount"), { value: "4815.00", evidence: "Total Due: $5,230.29" }, text);
    expect(v.value).toBeNull();
    expect(v.gapReason).toMatch(/not stated/);
  });

  it("keeps the model's reason for a missing field", () => {
    const v = validateCandidate(def("vendor_name"), { value: null, evidence: null, reason: "No vendor" }, text);
    expect(v).toMatchObject({ value: null, gapReason: "No vendor" });
  });

  it("never accepts evidence from another version's text", async () => {
    const v2 = await pdfText("invoice-001.v2.pdf");
    const cand = { value: "6126.45", evidence: "Total Due: $6,126.45" };
    expect(validateCandidate(def("total_amount"), cand, v2).value).toBe("6126.45");
    expect(validateCandidate(def("total_amount"), cand, text).value).toBeNull();
  });
});

describe("carry-over on the real revised invoice", () => {
  it("flags exactly due_date and total_amount as changed", async () => {
    const [t1, t2] = await Promise.all([pdfText("invoice-001.pdf"), pdfText("invoice-001.v2.pdf")]);
    const v1: Record<string, { value: string; evidence: string }> = {
      invoice_number: { value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847" },
      issue_date: { value: "2025-09-14", evidence: "Issue Date: 2025-09-14" },
      due_date: { value: "2025-10-14", evidence: "Due Date: 2025-10-14" },
      vendor_name: { value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC" },
      total_amount: { value: "5230.29", evidence: "Total Due: $5,230.29" },
    };
    // v2 as the LLM might return it: some quotes worded differently but still verbatim.
    const v2: Record<string, { value: string; evidence: string }> = {
      invoice_number: { value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847" },
      issue_date: { value: "2025-09-14", evidence: "Issue Date: 2025-09-14" },
      due_date: { value: "2025-11-13", evidence: "Due Date: 2025-11-13" },
      vendor_name: { value: "Meridian Office Supplies LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC" },
      total_amount: { value: "6126.45", evidence: "Total Due: $6,126.45" },
    };
    const changed = FIELDS.invoice
      .filter((f) => {
        const next = validateCandidate(f, v2[f.field], t2);
        const prev = validateCandidate(f, v1[f.field], t1);
        return compareForCarryOver(f.type, prev, next, t2).change !== "unchanged";
      })
      .map((f) => f.field);
    expect(changed).toEqual(["due_date", "total_amount"]);
  });

  it("is independent of where the passage moved to", () => {
    const prev = { value: "2025-09-14", evidence: "Issue Date: 2025-09-14" };
    const shifted = "A whole new preamble paragraph.\n\nInvoice\nIssue Date: 2025-09-14\n";
    const next = { value: "2025-09-14", evidence: "Issue Date: 2025-09-14" };
    expect(compareForCarryOver("date", prev, next, shifted).change).toBe("unchanged");
  });

  it("treats same value with a different passage as changed", () => {
    const prev = { value: "2025-09-14", evidence: "Issue Date: 2025-09-14" };
    const text = "This revised invoice supersedes the version issued on 2025-09-14";
    const next = { value: "2025-09-14", evidence: "version issued on 2025-09-14" };
    expect(compareForCarryOver("date", prev, next, text).change).toBe("changed");
  });

  it("never carries over gaps", () => {
    expect(compareForCarryOver("money", { value: null, evidence: null }, { value: null, evidence: null }, "").change).toBe(
      "changed",
    );
    expect(compareForCarryOver("money", undefined, { value: "1", evidence: "1" }, "1").change).toBe("new");
  });
});
