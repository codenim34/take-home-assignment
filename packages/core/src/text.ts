/** Low-level text scanning shared by the field types. No knowledge of fields. */

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. Feb 30
  return `${y}-${pad(m)}-${pad(d)}`;
}

const monthNumber = (name: string) => MONTHS[name.toLowerCase().slice(0, 3)];

const DATE_PATTERNS: { re: RegExp; toIso: (m: RegExpMatchArray) => string | null }[] = [
  // 2025-09-14
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, toIso: (m) => isoDate(+m[1]!, +m[2]!, +m[3]!) },
  // March 1, 2025 / Mar 1 2025
  {
    re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    toIso: (m) => {
      const mon = monthNumber(m[1]!);
      return mon ? isoDate(+m[3]!, mon, +m[2]!) : null;
    },
  },
  // 1 March 2025
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
    toIso: (m) => {
      const mon = monthNumber(m[2]!);
      return mon ? isoDate(+m[3]!, mon, +m[1]!) : null;
    },
  },
  // 03/01/2025 (US order)
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, toIso: (m) => isoDate(+m[3]!, +m[1]!, +m[2]!) },
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

/** A single bare numeric value: "$1,234.50", "4.2%", "USD 24" -> number; anything else -> null. */
export function parseNumeric(raw: string): number | null {
  const cleaned = raw.replace(/usd|\$|%|,|\s/gi, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
