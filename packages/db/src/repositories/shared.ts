import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../client.js";
import { documents, documentVersions, reviews } from "../schema.js";
import { DomainError } from "./errors.js";
import type { DocumentRow, ReviewRow } from "./types.js";

/**
 * Row lock on the document. Every write that depends on "which version is
 * current" (upload, retry, review) takes it, so those writes are serialised.
 */
export async function lockDocument(tx: Tx, documentId: string): Promise<DocumentRow> {
  const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
  if (!doc) throw new DomainError("not_found", `Document ${documentId} not found`);
  return doc;
}

/** The newest review per value (reviews are append-only). */
export async function latestReviews(db: Db | Tx, valueIds: string[]): Promise<Map<string, ReviewRow>> {
  const out = new Map<string, ReviewRow>();
  if (!valueIds.length) return out;
  const rows = await db
    .selectDistinctOn([reviews.valueId])
    .from(reviews)
    .where(inArray(reviews.valueId, valueIds))
    .orderBy(reviews.valueId, desc(reviews.createdAt), desc(reviews.id));
  for (const r of rows) out.set(r.valueId, r);
  return out;
}

/** `now() + ms` as a SQL expression, so lease/retry times use the database clock, not the worker's. */
export const fromNow = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`;

/** A version is due when it has no backoff or its backoff has passed. */
export const isDue = sql`(${documentVersions.retryAt} is null or ${documentVersions.retryAt} <= now())`;
