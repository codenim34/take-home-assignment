import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  compareForCarryOver,
  emptyProgress,
  fieldsFor,
  isDocumentType,
  normalizeValue,
  type ProgressCounts,
  type ValidatedValue,
} from "@lomi/core";
import type { Db, Tx } from "./client.js";
import { documentVersions, documents, extractedValues, extractionRuns, reviews } from "./schema.js";

export class DomainError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export type VersionRow = typeof documentVersions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ValueRow = typeof extractedValues.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface NewFile {
  fileName: string;
  pdf: Buffer;
}

/** Creates the document and version 1 (status `queued`) in one transaction. */
export async function createDocument(
  db: Db,
  input: { id?: string; type: string; title?: string } & NewFile,
): Promise<{ document: DocumentRow; version: VersionRow; created: boolean }> {
  if (!isDocumentType(input.type)) throw new DomainError("invalid", `Unknown document type "${input.type}"`);
  const type = input.type;
  return db.transaction(async (tx) => {
    const id = input.id ?? `doc-${randomUUID()}`;
    const inserted = await tx
      .insert(documents)
      .values({ id, type, title: input.title?.trim() || input.fileName })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Only reachable with a caller-chosen id (the seed): make it idempotent.
      const [doc] = await tx.select().from(documents).where(eq(documents.id, id));
      const [ver] = await tx.select().from(documentVersions).where(eq(documentVersions.id, doc!.currentVersionId!));
      return { document: doc!, version: ver!, created: false };
    }
    const [version] = await tx
      .insert(documentVersions)
      .values({ documentId: id, version: 1, fileName: input.fileName, fileSha256: sha256(input.pdf), pdf: input.pdf })
      .returning();
    const [document] = await tx
      .update(documents)
      .set({ currentVersionId: version!.id })
      .where(eq(documents.id, id))
      .returning();
    return { document: document!, version: version!, created: true };
  });
}

async function lockDocument(tx: Tx, documentId: string): Promise<DocumentRow> {
  const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
  if (!doc) throw new DomainError("not_found", `Document ${documentId} not found`);
  return doc;
}

/**
 * Adds version N+1. Policy for a version that is still queued/extracting (or
 * failed): it is SUPERSEDED. Its status flips in this transaction, so the old
 * worker's guarded commit (which requires status = 'extracting') can no longer
 * land. Nothing is deleted; the superseded version stays queryable.
 *
 * Uploading a byte-identical copy of the current version is a no-op that
 * returns the current version (an impatient double-upload must not create v3).
 */
export async function addVersion(
  db: Db,
  documentId: string,
  file: NewFile,
): Promise<{ version: VersionRow; duplicate: boolean; superseded: string[] }> {
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, documentId);
    const hash = sha256(file.pdf);
    const [current] = await tx.select().from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId!));
    if (current && current.fileSha256 === hash && current.status !== "failed") {
      return { version: current, duplicate: true, superseded: [] };
    }
    const superseded = await tx
      .update(documentVersions)
      .set({ status: "superseded", leaseExpiresAt: null })
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          inArray(documentVersions.status, ["queued", "extracting", "failed"]),
        ),
      )
      .returning({ id: documentVersions.id });
    if (superseded.length) {
      await tx
        .update(extractionRuns)
        .set({ status: "superseded", finishedAt: sql`now()`, error: "A newer version was uploaded" })
        .where(
          and(
            inArray(
              extractionRuns.versionId,
              superseded.map((s) => s.id),
            ),
            eq(extractionRuns.status, "running"),
          ),
        );
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${documentVersions.version}), 0)::int` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))) as [{ max: number }];
    const [version] = await tx
      .insert(documentVersions)
      .values({ documentId, version: max + 1, fileName: file.fileName, fileSha256: hash, pdf: file.pdf })
      .returning();
    await tx
      .update(documents)
      .set({ currentVersionId: version!.id, updatedAt: sql`now()` })
      .where(eq(documents.id, documentId));
    return { version: version!, duplicate: false, superseded: superseded.map((s) => s.id) };
  });
}

/** Failed -> queued, with a fresh attempt budget. Only for the current version. */
export async function retryCurrentVersion(db: Db, documentId: string): Promise<VersionRow> {
  return db.transaction(async (tx) => {
    const doc = await lockDocument(tx, documentId);
    const [updated] = await tx
      .update(documentVersions)
      .set({ status: "queued", attempts: 0, error: null, currentRunId: null, leaseExpiresAt: null })
      .where(and(eq(documentVersions.id, doc.currentVersionId!), eq(documentVersions.status, "failed")))
      .returning();
    if (!updated) throw new DomainError("conflict", "Only a failed current version can be retried");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Worker side: claim, heartbeat, commit, fail
// ---------------------------------------------------------------------------

/**
 * queued -> extracting, atomically, and only if still queued. Two deliveries
 * of the same job (retry, FLUSHALL re-enqueue, duplicate) race here and exactly
 * one wins. The winner gets a fresh run id (fencing token) and a lease.
 */
export async function claimVersion(
  db: Db,
  versionId: string,
  opts: { leaseMs: number; maxAttempts: number; model: string; workerId?: string },
): Promise<{ version: VersionRow; runId: string } | null> {
  return db.transaction(async (tx) => {
    const runId = randomUUID();
    const [version] = await tx
      .update(documentVersions)
      .set({
        status: "extracting",
        attempts: sql`${documentVersions.attempts} + 1`,
        currentRunId: runId,
        leaseExpiresAt: sql`now() + make_interval(secs => ${opts.leaseMs / 1000})`,
        error: null,
      })
      .where(
        and(
          eq(documentVersions.id, versionId),
          eq(documentVersions.status, "queued"),
          lt(documentVersions.attempts, opts.maxAttempts),
        ),
      )
      .returning();
    if (!version) return null;
    await tx
      .insert(extractionRuns)
      .values({ id: runId, versionId, attempt: version.attempts, model: opts.model, workerId: opts.workerId ?? null });
    return { version, runId };
  });
}

const ours = (versionId: string, runId: string) =>
  and(
    eq(documentVersions.id, versionId),
    eq(documentVersions.currentRunId, runId),
    eq(documentVersions.status, "extracting"),
  );

/** Extends the lease. Returns false if the run lost ownership (superseded, reclaimed). */
export async function heartbeat(db: Db, versionId: string, runId: string, leaseMs: number): Promise<boolean> {
  const rows = await db
    .update(documentVersions)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
    .where(ours(versionId, runId))
    .returning({ id: documentVersions.id });
  return rows.length > 0;
}

/** Store prompt / raw response for debugging. Not guarded: a log of what happened. */
export async function recordRunIO(
  db: Db,
  runId: string,
  io: { model?: string; prompt?: unknown; rawResponse?: unknown },
): Promise<void> {
  await db.update(extractionRuns).set(io).where(eq(extractionRuns.id, runId));
}

export type CommitResult = { committed: true; values: number; carried: number } | { committed: false; reason: string };

/**
 * The guarded commit. In ONE transaction:
 *   - re-check that this run still owns the version (status + run id),
 *   - compare against the latest extracted version and carry reviews over,
 *   - insert all values, flip the version to `extracted`.
 * Either all of it lands or none of it does. Doing the carry-over comparison
 * inside this transaction means it reads the previous reviews as they are at
 * commit time, not as they were when the LLM call started.
 */
export async function commitExtraction(
  db: Db,
  input: { versionId: string; runId: string; parsedText: string; values: ValidatedValue[] },
): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, input.versionId))
      .for("update");
    if (!version || version.status !== "extracting" || version.currentRunId !== input.runId) {
      const reason = version?.status === "superseded" ? "superseded" : "lost ownership";
      await tx
        .update(extractionRuns)
        .set({
          status: version?.status === "superseded" ? "superseded" : "abandoned",
          finishedAt: sql`now()`,
          error: `Result discarded: ${reason}`,
        })
        .where(eq(extractionRuns.id, input.runId));
      return { committed: false, reason };
    }

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

    const prevByField = new Map<string, { value: ValueRow; review: ReviewRow | null }>();
    if (base) {
      const prevValues = await tx.select().from(extractedValues).where(eq(extractedValues.versionId, base.id));
      const latest = await latestReviews(
        tx,
        prevValues.map((v) => v.id),
      );
      for (const v of prevValues) prevByField.set(v.field, { value: v, review: latest.get(v.id) ?? null });
    }

    let carried = 0;
    for (const v of input.values) {
      const prev = prevByField.get(v.field);
      const decision = compareForCarryOver(v.fieldType, prev?.value, v, input.parsedText);
      const carry = decision.change === "unchanged" && prev?.review != null;
      const [row] = await tx
        .insert(extractedValues)
        .values({
          versionId: version.id,
          runId: input.runId,
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
          reviewState: carry ? "carried_over" : "pending",
        })
        .onConflictDoNothing()
        .returning();
      if (row && carry && prev?.review) {
        carried++;
        await tx.insert(reviews).values({
          valueId: row.id,
          action: prev.review.action,
          correctedValue: prev.review.correctedValue,
          note: prev.review.note,
          reviewer: prev.review.reviewer,
          isCarried: true,
          carriedFromReviewId: prev.review.carriedFromReviewId ?? prev.review.id,
        });
      }
    }

    await tx
      .update(documentVersions)
      .set({
        status: "extracted",
        parsedText: input.parsedText,
        extractedAt: sql`now()`,
        leaseExpiresAt: null,
        baseVersionId: base?.id ?? null,
      })
      .where(eq(documentVersions.id, version.id));
    await tx
      .update(extractionRuns)
      .set({ status: "succeeded", finishedAt: sql`now()` })
      .where(eq(extractionRuns.id, input.runId));
    return { committed: true, values: input.values.length, carried };
  });
}

/**
 * Guarded failure. `requeue` is used on graceful shutdown: the attempt is
 * handed back (not counted) so a `docker compose restart` resumes instantly.
 */
export async function failRun(
  db: Db,
  input: { versionId: string; runId: string; error: string; requeue?: boolean; parsedText?: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(documentVersions)
      .set(
        input.requeue
          ? {
              status: "queued",
              attempts: sql`greatest(${documentVersions.attempts} - 1, 0)`,
              currentRunId: null,
              leaseExpiresAt: null,
            }
          : { status: "failed", error: input.error, leaseExpiresAt: null, parsedText: input.parsedText ?? null },
      )
      .where(ours(input.versionId, input.runId))
      .returning({ id: documentVersions.id });
    await tx
      .update(extractionRuns)
      .set({ status: input.requeue ? "abandoned" : "failed", error: input.error, finishedAt: sql`now()` })
      .where(and(eq(extractionRuns.id, input.runId), eq(extractionRuns.status, "running")));
    return rows.length > 0;
  });
}

/**
 * Called once when a worker starts. Any run still `running` under this
 * worker's id belongs to its previous incarnation (killed or restarted), so it
 * is certainly dead: expire its lease now instead of waiting for it to time
 * out. The next reconcile() then re-queues it like any other expired lease.
 */
export async function expireOrphanedLeases(db: Db, workerId: string): Promise<string[]> {
  const rows = await db
    .update(documentVersions)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(
      and(
        eq(documentVersions.status, "extracting"),
        inArray(
          documentVersions.currentRunId,
          db
            .select({ id: extractionRuns.id })
            .from(extractionRuns)
            .where(and(eq(extractionRuns.workerId, workerId), eq(extractionRuns.status, "running"))),
        ),
      ),
    )
    .returning({ id: documentVersions.id });
  return rows.map((r) => r.id);
}

/**
 * Recovery sweep, run at worker startup and periodically. Makes Postgres the
 * only thing that has to survive:
 *   1. `extracting` with an expired lease (worker died) -> back to `queued`,
 *      or `failed` once the attempt budget is spent (poison documents can't loop).
 *   2. every `queued` version is returned so the caller can (re-)enqueue it.
 *      After a Redis FLUSHALL this rebuilds the whole queue.
 */
export async function reconcile(
  db: Db,
  maxAttempts: number,
): Promise<{ requeued: string[]; failed: string[]; queued: { id: string; attempts: number }[] }> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(documentVersions)
      .set({
        status: sql`(case when ${documentVersions.attempts} >= ${maxAttempts} then 'failed' else 'queued' end)::version_status`,
        error: sql`case when ${documentVersions.attempts} >= ${maxAttempts} then ${`Extraction was interrupted ${maxAttempts} times; giving up. Retry to try again.`} else null end`,
        leaseExpiresAt: null,
      })
      .where(and(eq(documentVersions.status, "extracting"), lt(documentVersions.leaseExpiresAt, sql`now()`)))
      .returning({ id: documentVersions.id, status: documentVersions.status, runId: documentVersions.currentRunId });
    const runIds = expired.map((e) => e.runId).filter((r): r is string => !!r);
    if (runIds.length) {
      await tx
        .update(extractionRuns)
        .set({ status: "abandoned", finishedAt: sql`now()`, error: "Lease expired (worker stopped or crashed)" })
        .where(and(inArray(extractionRuns.id, runIds), eq(extractionRuns.status, "running")));
    }
    const queued = await tx
      .select({ id: documentVersions.id, attempts: documentVersions.attempts })
      .from(documentVersions)
      .where(eq(documentVersions.status, "queued"))
      .orderBy(documentVersions.createdAt);
    return {
      requeued: expired.filter((e) => e.status === "queued").map((e) => e.id),
      failed: expired.filter((e) => e.status === "failed").map((e) => e.id),
      queued,
    };
  });
}

export async function getVersionForExtraction(db: Db, versionId: string) {
  const [row] = await db
    .select({ version: documentVersions, type: documents.type })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, versionId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Corrections are annotations: the LLM's value is never overwritten, a review
 * row is appended and the value's review_state updated. The document row lock
 * serialises this against uploads, so a review can't land on a version that
 * just stopped being current.
 */
export async function reviewValue(
  db: Db,
  valueId: string,
  input: { action: "approve" | "correct"; value?: string | null; note?: string | null; reviewer?: string | null },
): Promise<{ value: ValueRow; review: ReviewRow }> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ value: extractedValues, version: documentVersions })
      .from(extractedValues)
      .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
      .where(eq(extractedValues.id, valueId));
    if (!found) throw new DomainError("not_found", `Value ${valueId} not found`);
    const doc = await lockDocument(tx, found.version.documentId);
    if (doc.currentVersionId !== found.version.id) {
      throw new DomainError("conflict", "This value belongs to an older version; review the current version instead");
    }
    let corrected: string | null = null;
    if (input.action === "correct") {
      if (!input.value || !input.value.trim()) throw new DomainError("invalid", "A correction needs a value");
      corrected = normalizeValue(found.value.fieldType as never, input.value);
      if (corrected === null) {
        throw new DomainError("invalid", `"${input.value}" is not a valid ${found.value.fieldType}`);
      }
    }
    const [review] = await tx
      .insert(reviews)
      .values({
        valueId,
        action: input.action,
        correctedValue: corrected,
        note: input.note?.trim() || null,
        reviewer: input.reviewer?.trim() || "reviewer",
      })
      .returning();
    const [value] = await tx
      .update(extractedValues)
      .set({ reviewState: input.action === "approve" ? "approved" : "corrected" })
      .where(eq(extractedValues.id, valueId))
      .returning();
    return { value: value!, review: review! };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function latestReviews(tx: Db | Tx, valueIds: string[]): Promise<Map<string, ReviewRow>> {
  const out = new Map<string, ReviewRow>();
  if (!valueIds.length) return out;
  const rows = await tx
    .selectDistinctOn([reviews.valueId])
    .from(reviews)
    .where(inArray(reviews.valueId, valueIds))
    .orderBy(reviews.valueId, desc(reviews.createdAt), desc(reviews.id));
  for (const r of rows) out.set(r.valueId, r);
  return out;
}

export async function progressFor(db: Db | Tx, versionIds: string[]): Promise<Map<string, ProgressCounts>> {
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

  const order = fieldsFor(doc.type as never).map((f) => f.field);
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
