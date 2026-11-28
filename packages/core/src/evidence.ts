import type { FieldDef } from "./fields.js";
import { fieldType } from "./field-types.js";

export interface EvidenceMatch {
  start: number;
  end: number;
  /** "exact": byte-for-byte substring. "whitespace": identical except runs of whitespace (PDF line breaks). */
  matchKind: "exact" | "whitespace";
}

/**
 * Locate a quote in the parsed text of the version being extracted.
 *
 * We accept an exact substring first. Failing that, we allow differences in
 * whitespace only (a quote that spans a PDF line break is often returned with
 * a space instead of "\n"). No other leniency: different characters = not found.
 * Offsets always refer to the original text so the UI can highlight them.
 */
export function findEvidence(text: string, quote: string): EvidenceMatch | null {
  const q = quote.trim();
  if (!q) return null;

  const exact = text.indexOf(q);
  if (exact !== -1) return { start: exact, end: exact + q.length, matchKind: "exact" };

  // Collapse whitespace runs in the text, remembering where each char came from.
  let collapsed = "";
  const origin: number[] = [];
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inWs) {
        collapsed += " ";
        origin.push(i);
      }
      inWs = true;
    } else {
      collapsed += ch;
      origin.push(i);
      inWs = false;
    }
  }
  const cq = q.replace(/\s+/g, " ");
  const idx = collapsed.indexOf(cq);
  if (idx === -1) return null;
  const start = origin[idx]!;
  const lastOrigin = origin[idx + cq.length - 1]!;
  return { start, end: lastOrigin + 1, matchKind: "whitespace" };
}

/** What the LLM said about one field (already schema-validated). */
export interface CandidateValue {
  value: string | null;
  evidence: string | null;
  reason?: string | null;
}

export interface ValidatedValue {
  field: string;
  fieldType: FieldDef["type"];
  /** Canonical value, or null when this is a gap. */
  value: string | null;
  /** Value exactly as the LLM returned it (kept for debugging/UI). */
  rawValue: string | null;
  evidence: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  evidenceMatch: EvidenceMatch["matchKind"] | null;
  /** Set iff value is null. */
  gapReason: string | null;
}

function gap(def: FieldDef, rawValue: string | null, reason: string): ValidatedValue {
  return {
    field: def.field,
    fieldType: def.type,
    value: null,
    rawValue,
    evidence: null,
    evidenceStart: null,
    evidenceEnd: null,
    evidenceMatch: null,
    gapReason: reason,
  };
}

/**
 * The hallucination defense. A candidate is only kept if
 *   1. it has a value and a quote,
 *   2. the value parses as the field's type,
 *   3. the quote appears (verbatim, modulo whitespace) in THIS version's text,
 *   4. the value is actually stated inside that quote.
 * Anything else becomes a gap with a reason. We never keep a guess.
 */
export function validateCandidate(
  def: FieldDef,
  candidate: CandidateValue | undefined,
  text: string,
): ValidatedValue {
  if (!candidate || candidate.value === null || candidate.value.trim() === "") {
    return gap(def, null, candidate?.reason?.trim() || "Not found in the document");
  }
  const raw = candidate.value;
  if (!candidate.evidence || !candidate.evidence.trim()) {
    return gap(def, raw, "The model returned a value without a supporting quote");
  }
  const type = fieldType(def.type);
  const canonical = type.normalize(raw);
  if (canonical === null) {
    return gap(def, raw, `Could not read "${raw}" as a ${def.type}`);
  }
  const match = findEvidence(text, candidate.evidence);
  if (!match) {
    return gap(
      def,
      raw,
      `Quoted evidence does not appear in the document text (rejected quote: "${candidate.evidence.slice(0, 200)}")`,
    );
  }
  const quote = text.slice(match.start, match.end);
  if (!type.isStatedIn(canonical, quote)) {
    return gap(def, raw, `Value "${raw}" is not stated in the quoted evidence "${quote.slice(0, 200)}"`);
  }
  return {
    field: def.field,
    fieldType: def.type,
    value: canonical,
    rawValue: raw,
    evidence: quote,
    evidenceStart: match.start,
    evidenceEnd: match.end,
    evidenceMatch: match.matchKind,
    gapReason: null,
  };
}
