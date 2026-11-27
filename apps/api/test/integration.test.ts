/**
 * Integration tests against real Postgres and Redis, with a scripted LLM.
 * They cover the behaviours the brief says will be tested: instant upload,
 * restart/crash recovery, FLUSHALL, idempotency, failure as state,
 * hallucination defence, carry-over, and a new version mid-extraction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { claimVersion, documentVersions, extractedValues, extractionRuns, reconcile, type Db } from "@lomi/db";
import { ScriptedExtractor } from "@lomi/extraction";
import { ExtractionQueue } from "@lomi/queue";
import { processVersion, reconcileOnce } from "@lomi/worker";
import {
  REDIS_URL,
  RecordingQueue,
  deps,
  gatedExtractor,
  goodExtractor,
  invoiceAnswer,
  log,
  makeApp,
  pdf,
  resetDb,
  setupDb,
  upload,
} from "./helpers.js";

let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  ({ db, close: closeDb } = await setupDb());
});
afterAll(async () => closeDb());
beforeEach(async () => resetDb(db));

async function uploadInvoice(queue = new RecordingQueue()) {
  const app = await makeApp(db, queue);
  const res = await upload(app, "/documents", pdf("invoice-001.pdf"), { type: "invoice", title: "Invoice" });
  expect(res.statusCode).toBe(202);
  const { id } = res.json() as { id: string };
  const [version] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, id));
  return { app, id, versionId: version!.id, queue };
}

const getDoc = async (app: Awaited<ReturnType<typeof makeApp>>, id: string, q = "") =>
  (await app.inject({ method: "GET", url: `/documents/${id}${q}` })).json();

describe("ingest", () => {
  it("responds immediately with queued, without touching the LLM", async () => {
    const started = Date.now();
    const { app, id, queue } = await uploadInvoice();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(queue.jobs).toHaveLength(1);
    expect((await getDoc(app, id)).version.status).toBe("queued");
  });

  it("still accepts the upload when Redis is down (reconciler enqueues it later)", async () => {
    const queue = new RecordingQueue();
    queue.fail = true;
    const { app, id } = await uploadInvoice(queue);
    expect((await getDoc(app, id)).version.status).toBe("queued");
    const r = await reconcile(db, 3);
    expect(r.queued).toHaveLength(1);
  });

  it("rejects non-PDFs and unknown types", async () => {
    const app = await makeApp(db);
    expect((await upload(app, "/documents", Buffer.from("hello"), { type: "invoice" })).statusCode).toBe(400);
    expect((await upload(app, "/documents", pdf("invoice-001.pdf"), { type: "receipt" })).statusCode).toBe(400);
  });
});

describe("extraction", () => {
  it("extracts values with evidence that points into the stored text", async () => {
    const { app, id, versionId } = await uploadInvoice();
    expect(await processVersion(deps(db, goodExtractor()), versionId)).toBe("extracted");
    const doc = await getDoc(app, id);
    expect(doc.version.status).toBe("extracted");
    expect(doc.values).toHaveLength(5);
    for (const v of doc.values) {
      expect(v.value).not.toBeNull();
      expect(doc.parsedText.slice(v.evidenceStart, v.evidenceEnd)).toBe(v.evidence);
    }
    const runs = (await app.inject({ url: `/documents/${id}/versions/1/runs` })).json().runs;
    expect(runs[0].prompt).toBeTruthy();
    expect(runs[0].rawResponse).toBeTruthy();
  });

  it("stores a hallucinated quote as a gap, never as a value", async () => {
    const { app, id, versionId } = await uploadInvoice();
    const liar = new ScriptedExtractor((req) => ({
      ...invoiceAnswer(req),
      total_amount: { value: "9999.00", evidence: "Grand Total: $9,999.00", reason: null },
      due_date: { value: "2025-12-01", evidence: "Due Date: 2025-10-14", reason: null },
      vendor_name: { value: null, evidence: null, reason: "Vendor not stated" },
    }));
    await processVersion(deps(db, liar), versionId);
    const byField = Object.fromEntries((await getDoc(app, id)).values.map((v: { field: string }) => [v.field, v]));
    expect(byField.total_amount).toMatchObject({ value: null, evidence: null });
    expect(byField.total_amount.gapReason).toMatch(/does not appear/);
    expect(byField.due_date).toMatchObject({ value: null });
    expect(byField.due_date.gapReason).toMatch(/not stated in the quoted evidence/);
    expect(byField.vendor_name).toMatchObject({ value: null, gapReason: "Vendor not stated" });
  });

  it("is idempotent: concurrent and repeated runs of one version store one set of values", async () => {
    const { versionId } = await uploadInvoice();
    const extractor = goodExtractor();
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => processVersion(deps(db, extractor), versionId)));
    expect(outcomes.filter((o) => o === "extracted")).toHaveLength(1);
    expect(await processVersion(deps(db, extractor), versionId)).toBe("not_claimed");
    const values = await db.select().from(extractedValues).where(eq(extractedValues.versionId, versionId));
    expect(values).toHaveLength(5);
    expect(extractor.calls).toBe(1);
  });

  it("turns an LLM error into a visible failed state, and retry recovers it", async () => {
    const { app, id, versionId, queue } = await uploadInvoice();
    const flaky = new ScriptedExtractor((req, call) => {
      if (call === 1) throw new (class extends Error {})("boom: 529 overloaded");
      return invoiceAnswer(req);
    });
    expect(await processVersion(deps(db, flaky), versionId)).toBe("failed");
    const failed = await getDoc(app, id);
    expect(failed.version.status).toBe("failed");
    expect(failed.version.error).toMatch(/boom/);

    const retry = await app.inject({ method: "POST", url: `/documents/${id}/retry` });
    expect(retry.statusCode).toBe(202);
    expect(queue.jobs.at(-1)).toEqual({ versionId, attempts: 0 });
    expect((await app.inject({ method: "POST", url: `/documents/${id}/retry` })).statusCode).toBe(409);
    expect(await processVersion(deps(db, flaky), versionId)).toBe("extracted");
  });

  it("marks an unparseable PDF as failed", async () => {
    const { versionId } = await uploadInvoice();
    await db.update(documentVersions).set({ pdf: Buffer.from("%PDF-1.4 garbage") }).where(eq(documentVersions.id, versionId));
    expect(await processVersion(deps(db, goodExtractor()), versionId)).toBe("failed");
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    expect(v!.error).toMatch(/Could not parse PDF/);
  });
});

describe("crash and restart recovery", () => {
  it("a worker killed mid-extraction: lease expires, reconciler re-queues, next run completes", async () => {
    const { versionId } = await uploadInvoice();
    // Simulate a worker that claimed the job and then died (no heartbeat, no commit).
    const dead = await claimVersion(db, versionId, { leaseMs: 30_000, maxAttempts: 3, model: "x" });
    expect(dead).not.toBeNull();
    expect(await processVersion(deps(db, goodExtractor()), versionId)).toBe("not_claimed");

    await db.update(documentVersions).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(documentVersions.id, versionId));
    const r = await reconcile(db, 3);
    expect(r.requeued).toEqual([versionId]);
    expect(await processVersion(deps(db, goodExtractor()), versionId)).toBe("extracted");

    const runs = await db.select().from(extractionRuns).where(eq(extractionRuns.versionId, versionId));
    expect(runs.map((r) => r.status).sort()).toEqual(["abandoned", "succeeded"]);
  });

  it("the zombie worker that comes back late cannot commit over the new run", async () => {
    const { versionId } = await uploadInvoice();
    const { extractor, release, started } = gatedExtractor();
    const zombie = processVersion(deps(db, extractor, { config: { leaseMs: 30_000, heartbeatMs: 60_000, maxAttempts: 3 } }), versionId);
    await started;
    await db.update(documentVersions).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(documentVersions.id, versionId));
    await reconcile(db, 3);
    expect(await processVersion(deps(db, goodExtractor()), versionId)).toBe("extracted");
    release();
    expect(await zombie).toBe("lost_ownership");
    const values = await db.select().from(extractedValues).where(eq(extractedValues.versionId, versionId));
    expect(values).toHaveLength(5);
  });

  it("gives up after max attempts so a poison document can't loop forever", async () => {
    const { versionId } = await uploadInvoice();
    for (let i = 0; i < 3; i++) {
      await claimVersion(db, versionId, { leaseMs: 30_000, maxAttempts: 3, model: "x" });
      await db.update(documentVersions).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(documentVersions.id, versionId));
      await reconcile(db, 3);
    }
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    expect(v!.status).toBe("failed");
    expect(v!.error).toMatch(/interrupted 3 times/);
  });

  it("graceful shutdown hands the in-flight run back without spending an attempt", async () => {
    const { versionId } = await uploadInvoice();
    const { extractor, started } = gatedExtractor();
    const shutdown = new AbortController();
    const run = processVersion(deps(db, extractor, { shutdownSignal: shutdown.signal }), versionId);
    await started;
    shutdown.abort();
    expect(await run).toBe("requeued_on_shutdown");
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    expect(v).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("FLUSHALL on Redis: the reconciler rebuilds the queue from Postgres", async () => {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new ExtractionQueue(redis);
    try {
      await redis.flushdb();
      const { versionId: queuedId } = await uploadInvoice();
      const app = await makeApp(db);
      const res = await upload(app, "/documents", pdf("lease-excerpt-001.pdf"), { type: "lease" });
      const leaseId = (res.json() as { id: string }).id;
      const [leaseVersion] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, leaseId));
      // The lease version was mid-extraction when Redis was wiped and its worker died.
      await claimVersion(db, leaseVersion!.id, { leaseMs: 30_000, maxAttempts: 3, model: "x" });
      await db.update(documentVersions).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(documentVersions.id, leaseVersion!.id));

      await redis.flushdb();
      expect(await queue.queue.getWaitingCount()).toBe(0);

      await reconcileOnce(db, queue, 3, log);
      const waiting = await queue.queue.getWaiting();
      expect(waiting.map((j) => j.data.versionId).sort()).toEqual([queuedId, leaseVersion!.id].sort());
      // Running it again doesn't duplicate jobs.
      await reconcileOnce(db, queue, 3, log);
      expect(await queue.queue.getWaitingCount()).toBe(2);
    } finally {
      await redis.flushdb();
      await queue.close();
      redis.disconnect();
    }
  });
});

describe("review", () => {
  it("approves and corrects (correction kept beside the original value)", async () => {
    const { app, id, versionId } = await uploadInvoice();
    await processVersion(deps(db, goodExtractor()), versionId);
    const [a, b] = (await getDoc(app, id)).values;
    expect((await app.inject({ method: "POST", url: `/values/${a.id}/review`, payload: { action: "approve" } })).statusCode).toBe(200);
    const corr = await app.inject({ method: "POST", url: `/values/${b.id}/review`, payload: { action: "correct", value: "Sept 15, 2025", note: "typo on PDF" } });
    expect(corr.statusCode).toBe(200);
    const doc = await getDoc(app, id);
    expect(doc.values[1]).toMatchObject({ value: "2025-09-14", effectiveValue: "2025-09-15", reviewState: "corrected" });
    expect(doc.values[1].review).toMatchObject({ action: "correct", note: "typo on PDF" });

    const progress = (await app.inject({ url: `/documents/${id}/progress` })).json();
    expect(progress).toMatchObject({ pending: 3, approved: 1, corrected: 1, carried_over: 0 });

    const bad = await app.inject({ method: "POST", url: `/values/${b.id}/review`, payload: { action: "correct", value: "not a date" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("re-extraction and carry-over", () => {
  async function reviewedV1() {
    const ctx = await uploadInvoice();
    await processVersion(deps(db, goodExtractor()), ctx.versionId);
    const values = (await getDoc(ctx.app, ctx.id)).values as { id: string; field: string }[];
    for (const v of values) {
      const payload = v.field === "vendor_name" ? { action: "correct", value: "Meridian Office Supplies, LLC" } : { action: "approve" };
      await ctx.app.inject({ method: "POST", url: `/values/${v.id}/review`, payload });
    }
    return ctx;
  }

  it("revised invoice: exactly the two changed fields need review, the rest keep their reviews", async () => {
    const { app, id } = await reviewedV1();
    const res = await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    expect(res.statusCode).toBe(202);
    const v2 = await getDoc(app, id);
    expect(v2.version).toMatchObject({ version: 2, status: "queued" });

    await processVersion(deps(db, goodExtractor()), v2.version.id);
    const doc = await getDoc(app, id);
    const pending = doc.values.filter((v: { reviewState: string }) => v.reviewState === "pending").map((v: { field: string }) => v.field);
    expect(pending).toEqual(["due_date", "total_amount"]);
    expect(doc.progress).toMatchObject({ pending: 2, carried_over: 3 });

    const byField = Object.fromEntries(doc.values.map((v: { field: string }) => [v.field, v]));
    expect(byField.due_date.previous).toMatchObject({ version: 1, value: "2025-10-14", review: { action: "approve" } });
    expect(byField.total_amount.previous.value).toBe("5230.29");
    // A carried-over correction keeps the corrected value.
    expect(byField.vendor_name).toMatchObject({ reviewState: "carried_over", effectiveValue: "Meridian Office Supplies, LLC" });
    expect(byField.vendor_name.review).toMatchObject({ action: "correct", isCarried: true });

    // Version 1 is still intact and queryable, with its own text and reviews.
    const v1 = await getDoc(app, id, "?version=1");
    expect(v1.version.isCurrent).toBe(false);
    expect(v1.parsedText).toContain("Due Date: 2025-10-14");
    expect(v1.values.every((v: { reviewState: string }) => v.reviewState !== "pending")).toBe(true);
  });

  it("reviews on an older version are rejected once a new version exists", async () => {
    const { app, id } = await reviewedV1();
    const oldValue = (await getDoc(app, id)).values[0];
    await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    const res = await app.inject({ method: "POST", url: `/values/${oldValue.id}/review`, payload: { action: "approve" } });
    expect(res.statusCode).toBe(409);
  });

  it("uploading the same file twice does not create another version", async () => {
    const { app, id } = await reviewedV1();
    await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    const again = await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ version: 2, duplicate: true });
  });

  it("a new version mid-extraction supersedes the running one; its late result is discarded", async () => {
    const { app, id } = await reviewedV1();
    await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    const v2Id = (await getDoc(app, id)).version.id;
    const { extractor, release, started } = gatedExtractor();
    const v2Run = processVersion(deps(db, extractor, { config: { leaseMs: 30_000, heartbeatMs: 60_000, maxAttempts: 3 } }), v2Id);
    await started;

    // v3 arrives (same bytes as v1 here, to make the carry-over base obvious).
    const v3Res = await upload(app, `/documents/${id}/versions`, pdf("invoice-001.pdf"));
    expect(v3Res.json()).toMatchObject({ version: 3, supersededVersionIds: [v2Id] });

    release();
    expect(await v2Run).toBe("lost_ownership");
    expect(await db.select().from(extractedValues).where(eq(extractedValues.versionId, v2Id))).toHaveLength(0);

    const v3 = await getDoc(app, id);
    await processVersion(deps(db, goodExtractor()), v3.version.id);
    const done = await getDoc(app, id);
    expect(done.version).toMatchObject({ version: 3, status: "extracted" });
    // Compared against v1 (the last *extracted* version), so everything carries over.
    expect(done.progress).toMatchObject({ pending: 0, carried_over: 5 });
    expect((await getDoc(app, id, "?version=2")).version.status).toBe("superseded");
  });

  it("the heartbeat notices a supersede and aborts the LLM call early", async () => {
    const { app, id } = await reviewedV1();
    await upload(app, `/documents/${id}/versions`, pdf("invoice-001.v2.pdf"));
    const v2Id = (await getDoc(app, id)).version.id;
    const { extractor, started } = gatedExtractor(); // never released
    const run = processVersion(deps(db, extractor), v2Id); // heartbeat every 50ms
    await started;
    await upload(app, `/documents/${id}/versions`, pdf("invoice-001.pdf"));
    expect(await run).toBe("lost_ownership");
  });
});
