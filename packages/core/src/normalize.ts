import type { FieldType } from "./fields.js";

/**
 * Canonical forms, so values can be compared across versions and checked
 * against their evidence regardless of how the LLM formatted them:
 *   string  -> trimmed, whitespace collapsed
 *   date    -> YYYY-MM-DD
 *   money   -> "1234.50" (two decimals, no symbols or separators)
 *   number  -> "24" / "2.5"
 *   percent -> "4.2" (no % sign)
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. Feb 30
  return `${y}-${pad(m)}-${pad(d)}`;
}

const DATE_PATTERNS: { re: RegExp; toIso: (m: RegExpMatchArray) => string | null }[] = [
  // 2025-09-14
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, toIso: (m) => validDate(+m[1]!, +m[2]!, +m[3]!) },
  // March 1, 2025 / Mar 1 2025
  {
    re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    toIso: (m) => {
      const mon = MONTHS[m[1]!.toLowerCase().slice(0, m[1]!.toLowerCase().startsWith("sept") ? 4 : 3)];
      return mon ? validDate(+m[3]!, mon, +m[2]!) : null;
    },
  },
  // 1 March 2025
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
    toIso: (m) => {
      const mon = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
      return mon ? validDate(+m[3]!, mon, +m[1]!) : null;
    },
  },
  // 03/01/2025 (US order)
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, toIso: (m) => validDate(+m[3]!, +m[1]!, +m[2]!) },
];

/** All dates mentioned in a piece of text, as YYYY-MM-DD. */
export function findDates(text: string): string[] {
  const out: string[] = [];
  for (const { re, toIso } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const iso = toIso(m);
      if (iso) out.push(iso);
    }
  }
  return out;
}

/** All numbers mentioned in a piece of text ("$5,230.29" -> 5230.29). */
export function findNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function parseNumeric(raw: string): number | null {
  const cleaned = raw.replace(/usd|\$|%|,|\s/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function numberToString(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** Returns the canonical form, or null if the raw value can't be read as `type`. */
export function normalizeValue(type: FieldType, raw: string): string | null {
  const v = collapseWhitespace(raw);
  if (!v) return null;
  switch (type) {
    case "string":
      return v;
    case "date": {
      const dates = findDates(v);
      return dates.length === 1 ? dates[0]! : null;
    }
    case "money": {
      const n = parseNumeric(v);
      return n === null ? null : n.toFixed(2);
    }
    case "number":
    case "percent": {
      const n = parseNumeric(v);
      return n === null ? null : numberToString(n);
    }
  }
}

/** Equality on canonical values. Strings compare case-insensitively. */
export function valuesEqual(type: FieldType, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (type === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Second hallucination check: the canonical value must actually be stated in
 * the quote. Catches "real quote, invented value" (e.g. quoting the subtotal
 * line but returning a different total).
 */
export function valueSupportedByQuote(type: FieldType, canonical: string, quote: string): boolean {
  switch (type) {
    case "string":
      return collapseWhitespace(quote).toLowerCase().includes(canonical.toLowerCase());
    case "date":
      return findDates(quote).includes(canonical);
    case "money":
    case "number":
    case "percent": {
      const target = Number(canonical);
      return findNumbers(quote).some((n) => Math.abs(n - target) < 1e-9);
    }
  }
}
