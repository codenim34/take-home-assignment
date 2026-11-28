import { collapseWhitespace, findDates, findNumbers, parseNumeric } from "./text.js";

/**
 * Everything the system needs to know about one kind of value, in one place
 * (Strategy pattern). Normalisation, the "is it stated in the quote" check,
 * equality across versions and the hint given to the LLM all come from here,
 * so adding a type (say "percent_range" or "iban") means adding one handler to
 * FIELD_TYPES and nothing else: the validator, carry-over, review API and
 * prompt pick it up without being edited.
 */
export interface FieldTypeHandler {
  /** Canonical form used for storage and comparison, or null if `raw` isn't this type. */
  normalize(raw: string): string | null;
  /** Is this canonical value actually stated in the quote? (second hallucination check) */
  isStatedIn(canonical: string, quote: string): boolean;
  /** Equality of two canonical values (carry-over). */
  equals(a: string, b: string): boolean;
  /** Formatting instruction for the LLM. */
  promptHint: string;
}

const exactEquals = (a: string, b: string) => a === b;

const numericStatedIn = (canonical: string, quote: string) => {
  const target = Number(canonical);
  return findNumbers(quote).some((n) => Math.abs(n - target) < 1e-9);
};

/** Number formatting without float noise: 2.5000000001 -> "2.5". */
const plainNumber = (n: number) => String(Number(n.toFixed(6)));

const string: FieldTypeHandler = {
  normalize: (raw) => collapseWhitespace(raw) || null,
  isStatedIn: (canonical, quote) => collapseWhitespace(quote).toLowerCase().includes(canonical.toLowerCase()),
  equals: (a, b) => a.toLowerCase() === b.toLowerCase(),
  promptHint: "the text as written",
};

const date: FieldTypeHandler = {
  normalize: (raw) => {
    const dates = findDates(collapseWhitespace(raw));
    return dates.length === 1 ? dates[0]! : null;
  },
  isStatedIn: (canonical, quote) => findDates(quote).includes(canonical),
  equals: exactEquals,
  promptHint: "ISO date YYYY-MM-DD",
};

const money: FieldTypeHandler = {
  normalize: (raw) => {
    const n = parseNumeric(raw);
    return n === null ? null : n.toFixed(2);
  },
  isStatedIn: numericStatedIn,
  equals: exactEquals,
  promptHint: "plain decimal number without currency symbol or thousands separators, e.g. 1234.50",
};

const number: FieldTypeHandler = {
  normalize: (raw) => {
    const n = parseNumeric(raw);
    return n === null ? null : plainNumber(n);
  },
  isStatedIn: numericStatedIn,
  equals: exactEquals,
  promptHint: "plain number, e.g. 24",
};

const percent: FieldTypeHandler = { ...number, promptHint: "plain number without %, e.g. 4.2" };

export const FIELD_TYPES = { string, date, money, number, percent } satisfies Record<string, FieldTypeHandler>;

export type FieldType = keyof typeof FIELD_TYPES;

export function isFieldType(t: unknown): t is FieldType {
  return typeof t === "string" && Object.hasOwn(FIELD_TYPES, t);
}

export function fieldType(type: FieldType): FieldTypeHandler {
  return FIELD_TYPES[type];
}
