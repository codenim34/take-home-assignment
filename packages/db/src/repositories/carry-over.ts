import { and, desc, eq, lt } from "drizzle-orm";
import { compareForCarryOver, type ValidatedValue } from "@lomi/core";
import type { Tx } from "../client.js";
import { documentVersions, extractedValues, reviews } from "../schema.js";
import { latestReviews } from "./shared.js";
import type { ReviewRow, ValueRow, VersionRow } from "./types.js";

interface Baseline {
  versionId: string | null;
  byField: Map<string, { value: ValueRow; review: ReviewRow | null }>;
}

/**
 * The version the new values are compared against: the newest *extracted*
 * version older than this one (a superseded or failed version in between has
 * no reviewed values to inherit). Read inside the commit transaction, so it
 * sees the reviews as they are at commit time, not when the LLM call started.
 */
async function loadBaseline(tx: Tx, version: VersionRow): Promise<Baseline> {
  const [base] = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, version.documentId),
        eq(documentVersions.status, "extracted"),
        lt(documentVersions.version, version.version),
      ),
    )
    .orderBy(desc(documentVersions.version))
    .limit(1);
  const byField: Baseline["byField"] = new Map();
  if (!base) return { versionId: null, byField };
  const prevValues = await tx.select().from(extractedValues).where(eq(extractedValues.versionId, base.id));
  const latest = await latestReviews(
    tx,
    prevValues.map((v) => v.id),
  );
  for (const v of prevValues) byField.set(v.field, { value: v, review: latest.get(v.id) ?? null });
  return { versionId: base.id, byField };
}

/**
 * Inserts the run's validated values, deciding per field whether the previous
 * human review carries over (see compareForCarryOver for the rule). A carried
 * review is copied, not moved: the old version's history stays untouched and
 * the copy points at the original review it came from.
 */
export async function insertValuesWithCarryOver(
  tx: Tx,
  version: VersionRow,
  runId: string,
  parsedText: string,
  values: ValidatedValue[],
): Promise<{ baseVersionId: string | null; carried: number }> {
  const baseline = await loadBaseline(tx, version);
  let carried = 0;
  for (const v of values) {
    const prev = baseline.byField.get(v.field);
    const decision = compareForCarryOver(v.fieldType, prev?.value, v, parsedText);
    const carriedReview = decision.change === "unchanged" ? prev?.review : null;
    const [row] = await tx
      .insert(extractedValues)
      .values({
        versionId: version.id,
        runId,
        field: v.field,
        fieldType: v.fieldType,
        value: v.value,
        rawValue: v.rawValue,
        evidence: v.evidence,
        evidenceStart: v.evidenceStart,
        evidenceEnd: v.evidenceEnd,
        evidenceMatch: v.evidenceMatch,
        gapReason: v.gapReason,
        change: decision.change,
        changeDetail: decision.detail,
        previousValueId: prev?.value.id ?? null,
        reviewState: carriedReview ? "carried_over" : "pending",
      })
      .onConflictDoNothing()
      .returning();
    if (row && carriedReview) {
      carried++;
      await tx.insert(reviews).values({
        valueId: row.id,
        action: carriedReview.action,
        correctedValue: carriedReview.correctedValue,
        note: carriedReview.note,
        reviewer: carriedReview.reviewer,
        isCarried: true,
        carriedFromReviewId: carriedReview.carriedFromReviewId ?? carriedReview.id,
      });
    }
  }
  return { baseVersionId: baseline.versionId, carried };
}
