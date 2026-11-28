import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isDocumentType } from "@lomi/core";
import type { Db } from "../client.js";
import { documents, documentVersions, extractionRuns } from "../schema.js";
import { DomainError } from "./errors.js";
import { lockDocument } from "./shared.js";
import type { DocumentRow, NewFile, VersionRow } from "./types.js";

/** Write side for uploads: new documents, new versions, manual retry. */

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

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
      .set({ status: "queued", attempts: 0, error: null, currentRunId: null, leaseExpiresAt: null, retryAt: null })
      .where(and(eq(documentVersions.id, doc.currentVersionId!), eq(documentVersions.status, "failed")))
      .returning();
    if (!updated) throw new DomainError("conflict", "Only a failed current version can be retried");
    return updated;
  });
}
