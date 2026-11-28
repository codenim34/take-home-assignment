import type { FieldType } from "./field-types.js";

/**
 * Field definitions per document type: pure data, so a new document type is a
 * new entry here (and its fields' types come from FIELD_TYPES). Mirrors
 * fixtures/expected-fields.json; a test asserts they stay in sync.
 */

export interface FieldDef {
  field: string;
  type: FieldType;
}

export const DOCUMENT_TYPES = ["invoice", "lease", "market_report"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const FIELDS: Record<DocumentType, readonly FieldDef[]> = {
  invoice: [
    { field: "invoice_number", type: "string" },
    { field: "issue_date", type: "date" },
    { field: "due_date", type: "date" },
    { field: "vendor_name", type: "string" },
    { field: "total_amount", type: "money" },
  ],
  lease: [
    { field: "tenant_name", type: "string" },
    { field: "monthly_rent", type: "money" },
    { field: "security_deposit", type: "money" },
    { field: "lease_start", type: "date" },
    { field: "term_months", type: "number" },
  ],
  market_report: [
    { field: "report_quarter", type: "string" },
    { field: "market_area", type: "string" },
    { field: "vacancy_rate", type: "percent" },
    { field: "average_rent_1br", type: "money" },
    { field: "year_over_year_rent_growth", type: "percent" },
    { field: "median_household_income", type: "money" },
  ],
};

export function isDocumentType(t: unknown): t is DocumentType {
  return typeof t === "string" && (DOCUMENT_TYPES as readonly string[]).includes(t);
}

export function fieldsFor(type: DocumentType): readonly FieldDef[] {
  return FIELDS[type];
}
