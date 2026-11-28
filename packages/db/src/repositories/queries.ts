import { and, eq, inArray, sql } from "drizzle-orm";
import { emptyProgress, fieldsFor, type DocumentType, type ProgressCounts } from "@lomi/core";
import type { Db } from "../client.js";
import { documents, documentVersions, extractedValues, extractionRuns } from "../schema.js";
import { DomainError } from "./errors.js";
import { latestReviews } from "./shared.js";
import type { ReviewRow, VersionRow } from "./types.js";

/** Read models for the API. No writes here (CQRS-lite: reads are shaped for the UI, writes live in the other repositories). */

async function progressFor(db: Db, versionIds: string[]): Promise<Map<string, ProgressCounts>> {
  const out = new Map<string, ProgressCounts>();
  if (!versionIds.length) return out;
  const rows = await db
    .select({
      versionId: extractedValues.versionId,
      state: extractedValues.reviewState,
      gap: sql<boolean>`${extractedValues.value} is null`,
      n: sql<number>`count(*)::int`,
    })
    .from(extractedValues)
    .where(inArray(extractedValues.versionId, versionIds))
    .groupBy(extractedValues.versionId, extractedValues.reviewState, sql`${extractedValues.value} is null`);
  for (const r of rows) {
    const p = out.get(r.versionId) ?? emptyProgress();
    p[r.state] += r.n;
    p.total += r.n;
    if (r.gap) p.gaps += r.n;
    out.set(r.versionId, p);
  }
  return out;
}

export async function listDocuments(db: Db) {
  const rows = await db
    .select({
      id: documents.id,
      type: documents.type,
      title: documents.title,
      updatedAt: documents.updatedAt,
      versionId: documentVersions.id,
      version: documentVersions.version,
      status: documentVersions.status,
      error: documentVersions.error,
    })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .orderBy(documents.createdAt);
  const progress = await progressFor(
    db,
    rows.map((r) => r.versionId).filter((x): x is string => !!x),
  );
  return rows.map(({ versionId, ...r }) => ({ ...r, progress: progress.get(versionId!) ?? emptyProgress() }));
}

function publicVersion(v: VersionRow) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    fileName: v.fileName,
    attempts: v.attempts,
    error: v.error,
    retryAt: v.retryAt,
    createdAt: v.createdAt,
    extractedAt: v.extractedAt,
    baseVersionId: v.baseVersionId,
  };
}

/** Full view of one version: values, their current review, and the previous version's value + review. */
export async function getDocument(db: Db, documentId: string, versionNumber?: number) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) throw new DomainError("not_found", `Document ${documentId} not found`);
  const versions = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(documentVersions.version);
  const selected =
    versionNumber === undefined
      ? versions.find((v) => v.id === doc.currentVersionId)
      : versions.find((v) => v.version === versionNumber);
  if (!selected) throw new DomainError("not_found", `Version ${versionNumber} not found`);

  const values = await db
    .select()
    .from(extractedValues)
    .where(eq(extractedValues.versionId, selected.id))
    .orderBy(extractedValues.createdAt);
  const prevIds = values.map((v) => v.previousValueId).filter((x): x is string => !!x);
  const prevValues = prevIds.length
    ? await db.select().from(extractedValues).where(inArray(extractedValues.id, prevIds))
    : [];
  const prevById = new Map(prevValues.map((p) => [p.id, p]));
  const latest = await latestReviews(db, [...values.map((v) => v.id), ...prevIds]);
  const versionNoById = new Map(versions.map((v) => [v.id, v.version]));

  const order = fieldsFor(doc.type as DocumentType).map((f) => f.field);
  values.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));

  const shapeReview = (r: ReviewRow | undefined) =>
    r
      ? {
          id: r.id,
          action: r.action,
          correctedValue: r.correctedValue,
          note: r.note,
          reviewer: r.reviewer,
          isCarried: r.isCarried,
          createdAt: r.createdAt,
        }
      : null;

  const progress = (await progressFor(db, [selected.id])).get(selected.id) ?? emptyProgress();
  return {
    document: { id: doc.id, type: doc.type, title: doc.title, currentVersionId: doc.currentVersionId },
    version: { ...publicVersion(selected), isCurrent: selected.id === doc.currentVersionId },
    versions: versions.map(publicVersion),
    parsedText: selected.parsedText,
    progress,
    values: values.map((v) => {
      const review = latest.get(v.id);
      const prev = v.previousValueId ? prevById.get(v.previousValueId) : undefined;
      return {
        id: v.id,
        field: v.field,
        fieldType: v.fieldType,
        value: v.value,
        rawValue: v.rawValue,
        effectiveValue: review?.action === "correct" ? review.correctedValue : v.value,
        evidence: v.evidence,
        evidenceStart: v.evidenceStart,
        evidenceEnd: v.evidenceEnd,
        evidenceMatch: v.evidenceMatch,
        gapReason: v.gapReason,
        reviewState: v.reviewState,
        change: v.change,
        changeDetail: v.changeDetail,
        review: shapeReview(review),
        previous: prev
          ? {
              version: versionNoById.get(prev.versionId) ?? null,
              value: prev.value,
              evidence: prev.evidence,
              gapReason: prev.gapReason,
              reviewState: prev.reviewState,
              review: shapeReview(latest.get(prev.id)),
            }
          : null,
      };
    }),
  };
}

export async function getProgress(db: Db, documentId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) throw new DomainError("not_found", `Document ${documentId} not found`);
  const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId!));
  const progress = (await progressFor(db, [version!.id])).get(version!.id) ?? emptyProgress();
  return { documentId, version: version!.version, status: version!.status, ...progress };
}

export async function listRuns(db: Db, documentId: string, versionNumber: number) {
  const [version] = await db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, versionNumber)));
  if (!version) throw new DomainError("not_found", "Version not found");
  return db
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.versionId, version.id))
    .orderBy(extractionRuns.startedAt);
}

export async function getPdf(db: Db, documentId: string, versionNumber: number) {
  const [row] = await db
    .select({ pdf: documentVersions.pdf, fileName: documentVersions.fileName })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, versionNumber)));
  if (!row) throw new DomainError("not_found", "Version not found");
  return row;
}
