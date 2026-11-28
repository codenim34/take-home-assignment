import type { FieldType } from "./fields.js";
import { findEvidence } from "./evidence.js";
import { collapseWhitespace, valuesEqual } from "./normalize.js";

export interface ComparableValue {
  value: string | null;
  evidence: string | null;
}

export type ChangeKind =
  /** No value for this field in the previous extracted version. */
  | "new"
  /** Same value, same evidence: previous review may be carried over. */
  | "unchanged"
  /** Different value, different evidence, or a gap on either side: must be re-reviewed. */
  | "changed";

export interface CarryDecision {
  change: ChangeKind;
  detail: string;
}

/**
 * Decide whether a field is "unchanged" between two versions.
 *
 * Unchanged requires BOTH:
 *   - the canonical value is equal, and
 *   - the evidence is the same passage: either the two quotes are identical
 *     (modulo whitespace) or the previous quote still appears verbatim in the
 *     new version's text.
 *
 * Positions/offsets are deliberately ignored, so text shifting around (a new
 * paragraph inserted above) doesn't matter. Gaps are never "unchanged": there
 * is no evidence to compare, so they go back to a human.
 *
 * The rule errs toward "changed": a false "changed" costs a reviewer a few
 * seconds, a false "unchanged" silently trusts a value nobody looked at.
 */
export function compareForCarryOver(
  type: FieldType,
  prev: ComparableValue | undefined,
  next: ComparableValue,
  nextText: string,
): CarryDecision {
  if (!prev) return { change: "new", detail: "No previous value" };
  if (prev.value === null || next.value === null) {
    return { change: "changed", detail: "Gap in one of the versions" };
  }
  if (!valuesEqual(type, prev.value, next.value)) {
    return { change: "changed", detail: `Value changed from ${prev.value} to ${next.value}` };
  }
  if (!prev.evidence || !next.evidence) {
    return { change: "changed", detail: "Missing evidence" };
  }
  if (collapseWhitespace(prev.evidence) === collapseWhitespace(next.evidence)) {
    return { change: "unchanged", detail: "Same value and same quote" };
  }
  if (findEvidence(nextText, prev.evidence)) {
    return { change: "unchanged", detail: "Same value; previous quote still present verbatim" };
  }
  return { change: "changed", detail: "Same value but the supporting passage changed" };
}
