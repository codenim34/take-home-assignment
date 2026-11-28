import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  isDocumentType,
  type ClaimOptions,
  type CommitResult,
  type ExtractionStore,
  type RecoveryStore,
  type RunRef,
  type ValidatedValue,
  type VersionToExtract,
} from "@lomi/core";
import type { Db, Tx } from "../client.js";
import { documents, documentVersions, extractionRuns } from "../schema.js";
import { insertValuesWithCarryOver } from "./carry-over.js";
import { fromNow, isDue } from "./shared.js";

/** The version row is still held by this run: same fencing token, still extracting. */
const ownedBy = (run: RunRef) =>
  and(
    eq(documentVersions.id, run.versionId),
    eq(documentVersions.currentRunId, run.runId),
    eq(documentVersions.status, "extracting"),
  );

type RunStatus = (typeof extractionRuns.$inferSelect)["status"];

async function closeRun(tx: Db | Tx, runId: string, status: RunStatus, error?: string) {
  await tx
    .update(extractionRuns)
    .set({ status, error: error ?? null, finishedAt: sql`now()` })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, "running")));
}

/**
 * Postgres adapter for the worker-facing ports. Every method is one atomic
 * statement or transaction, and every write after `claim` is guarded by the
 * run id (fencing token): a run that has been superseded, reclaimed or
 * timed out can call any of these and nothing changes.
 */
export class PgExtractionStore implements ExtractionStore, RecoveryStore {
  constructor(private readonly db: Db) {}

  /**
   * queued -> extracting, atomically, and only if still queued and due. Two
   * deliveries of the same job (retry, FLUSHALL re-enqueue, duplicate) race
   * here and exactly one wins. The winner gets a fresh run id and a lease.
   */
  async claim(versionId: string, opts: ClaimOptions): Promise<(RunRef & { version: VersionToExtract }) | null> {
    return this.db.transaction(async (tx) => {
      const runId = randomUUID();
      const [claimed] = await tx
        .update(documentVersions)
        .set({
          status: "extracting",
          attempts: sql`${documentVersions.attempts} + 1`,
          currentRunId: runId,
          leaseExpiresAt: fromNow(opts.leaseMs),
          retryAt: null,
        })
        .where(
          and(
            eq(documentVersions.id, versionId),
            eq(documentVersions.status, "queued"),
            lt(documentVersions.attempts, opts.maxAttempts),
            isDue,
          ),
        )
        .returning({ attempts: documentVersions.attempts, pdf: documentVersions.pdf, documentId: documentVersions.documentId });
      if (!claimed) return null;
      const [doc] = await tx.select({ type: documents.type }).from(documents).where(eq(documents.id, claimed.documentId));
      if (!doc || !isDocumentType(doc.type)) throw new Error(`Unknown document type for version ${versionId}`);
      await tx
        .insert(extractionRuns)
        .values({ id: runId, versionId, attempt: claimed.attempts, model: opts.model, workerId: opts.workerId ?? null });
      return {
        versionId,
        runId,
        version: { versionId, documentType: doc.type, pdf: claimed.pdf, attempt: claimed.attempts },
      };
    });
  }

  /** Extends the lease. False means the run lost ownership (superseded, reclaimed). */
  async renewLease(run: RunRef, leaseMs: number): Promise<boolean> {
    const rows = await this.db
      .update(documentVersions)
      .set({ leaseExpiresAt: fromNow(leaseMs) })
      .where(ownedBy(run))
      .returning({ id: documentVersions.id });
    return rows.length > 0;
  }

  /** Prompt / raw response for debugging. Not guarded: it is a log of what happened. */
  async recordRunIO(runId: string, io: { model?: string; prompt?: unknown; rawResponse?: unknown }): Promise<void> {
    await this.db.update(extractionRuns).set(io).where(eq(extractionRuns.id, runId));
  }

  /**
   * The guarded commit. In ONE transaction: re-check ownership under a row
   * lock, insert all values with carry-over, flip the version to `extracted`.
   * Either all of it lands or none of it does.
   */
  async commit(run: RunRef, result: { parsedText: string; values: ValidatedValue[] }): Promise<CommitResult> {
    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, run.versionId))
        .for("update");
      if (!version || version.status !== "extracting" || version.currentRunId !== run.runId) {
        const superseded = version?.status === "superseded";
        const reason = superseded ? "superseded" : "lost ownership";
        await closeRun(tx, run.runId, superseded ? "superseded" : "abandoned", `Result discarded: ${reason}`);
        return { committed: false, reason };
      }
      const { baseVersionId, carried } = await insertValuesWithCarryOver(
        tx,
        version,
        run.runId,
        result.parsedText,
        result.values,
      );
      await tx
        .update(documentVersions)
        .set({
          status: "extracted",
          error: null,
          parsedText: result.parsedText,
          extractedAt: sql`now()`,
          leaseExpiresAt: null,
          baseVersionId,
        })
        .where(eq(documentVersions.id, version.id));
      await closeRun(tx, run.runId, "succeeded");
      return { committed: true, values: result.values.length, carried };
    });
  }

  /** Permanent failure: the version shows the error until someone retries or uploads a new version. */
  async markFailed(run: RunRef, error: string, parsedText?: string): Promise<boolean> {
    return this.release(run, "failed", error, {
      status: "failed",
      error,
      leaseExpiresAt: null,
      parsedText: parsedText ?? null,
    });
  }

  /** Transient failure: back to `queued` once `delayMs` has passed (or `failed` if the attempts are spent). */
  async scheduleRetry(run: RunRef, error: string, delayMs: number, maxAttempts: number): Promise<boolean> {
    const outOfAttempts = sql`${documentVersions.attempts} >= ${maxAttempts}`;
    return this.release(run, "failed", error, {
      status: sql`(case when ${outOfAttempts} then 'failed' else 'queued' end)::version_status`,
      error: sql`case when ${outOfAttempts} then ${`${error} (gave up after ${maxAttempts} attempts)`} else ${`Will retry: ${error}`} end`,
      retryAt: fromNow(delayMs),
      currentRunId: null,
      leaseExpiresAt: null,
    });
  }

  /** Graceful shutdown: straight back to `queued` with the attempt handed back, so a restart resumes instantly. */
  async releaseForShutdown(run: RunRef): Promise<boolean> {
    return this.release(run, "abandoned", "Worker shut down mid-extraction", {
      status: "queued",
      attempts: sql`greatest(${documentVersions.attempts} - 1, 0)`,
      currentRunId: null,
      leaseExpiresAt: null,
    });
  }

  private async release(
    run: RunRef,
    runStatus: RunStatus,
    error: string,
    set: PgUpdateSetSource<typeof documentVersions>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(documentVersions)
        .set(set)
        .where(ownedBy(run))
        .returning({ id: documentVersions.id });
      await closeRun(tx, run.runId, runStatus, error);
      return rows.length > 0;
    });
  }

  /**
   * Called once when a worker starts. Any run still `running` under this
   * worker's id belongs to its previous incarnation (killed or restarted), so
   * it is certainly dead: expire its lease now instead of waiting it out. The
   * next reconcile() then re-queues it like any other expired lease.
   */
  async expireOrphanedLeases(workerId: string): Promise<string[]> {
    const rows = await this.db
      .update(documentVersions)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(
        and(
          eq(documentVersions.status, "extracting"),
          inArray(
            documentVersions.currentRunId,
            this.db
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
   *   2. every due `queued` version is returned so the caller can (re-)enqueue it.
   *      After a Redis FLUSHALL this rebuilds the whole queue.
   */
  async reconcile(maxAttempts: number) {
    return this.db.transaction(async (tx) => {
      const outOfAttempts = sql`${documentVersions.attempts} >= ${maxAttempts}`;
      const expired = await tx
        .update(documentVersions)
        .set({
          status: sql`(case when ${outOfAttempts} then 'failed' else 'queued' end)::version_status`,
          error: sql`case when ${outOfAttempts} then ${`Extraction was interrupted ${maxAttempts} times; giving up. Retry to try again.`} else null end`,
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
        .where(and(eq(documentVersions.status, "queued"), isDue))
        .orderBy(documentVersions.createdAt);
      return {
        requeued: expired.filter((e) => e.status === "queued").map((e) => e.id),
        failed: expired.filter((e) => e.status === "failed").map((e) => e.id),
        queued,
      };
    });
  }
}
