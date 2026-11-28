import type { FastifyInstance } from "fastify";
import { DOCUMENT_TYPES, isDocumentType, type JobQueue } from "@lomi/core";
import {
  DomainError,
  addVersion,
  createDocument,
  getDocument,
  getPdf,
  getProgress,
  listDocuments,
  listRuns,
  retryCurrentVersion,
  type Db,
} from "@lomi/db";
import { readUpload } from "../http/upload.js";

const versionNumber = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new DomainError("invalid", "version must be an integer");
  return n;
};

/**
 * Document routes. Every write follows the same shape: commit to Postgres
 * first, then nudge the queue (best effort). The response never waits for
 * the LLM, so uploads return 202 instantly.
 */
export function documentRoutes(app: FastifyInstance, deps: { db: Db; queue: JobQueue }): void {
  const { db, queue } = deps;

  app.get("/documents", async () => ({ documents: await listDocuments(db) }));

  app.post("/documents", async (req, reply) => {
    const { fields, file } = await readUpload(req);
    if (!isDocumentType(fields.type)) {
      throw new DomainError("invalid", `"type" must be one of ${DOCUMENT_TYPES.join(", ")}`);
    }
    const { document, version } = await createDocument(db, { type: fields.type, title: fields.title, ...file });
    await queue.enqueue(version.id, version.attempts);
    return reply.status(202).send({ id: document.id, version: version.version, status: version.status });
  });

  app.post<{ Params: { id: string } }>("/documents/:id/versions", async (req, reply) => {
    const { file } = await readUpload(req);
    const { version, duplicate, superseded } = await addVersion(db, req.params.id, file);
    if (!duplicate) await queue.enqueue(version.id, version.attempts);
    return reply.status(duplicate ? 200 : 202).send({
      id: req.params.id,
      version: version.version,
      status: version.status,
      duplicate,
      supersededVersionIds: superseded,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>("/documents/:id", async (req) =>
    getDocument(db, req.params.id, req.query.version ? versionNumber(req.query.version) : undefined),
  );

  app.get<{ Params: { id: string; version: string } }>("/documents/:id/versions/:version", async (req) =>
    getDocument(db, req.params.id, versionNumber(req.params.version)),
  );

  app.get<{ Params: { id: string } }>("/documents/:id/progress", async (req) => getProgress(db, req.params.id));

  app.post<{ Params: { id: string } }>("/documents/:id/retry", async (req, reply) => {
    const version = await retryCurrentVersion(db, req.params.id);
    await queue.enqueue(version.id, version.attempts);
    return reply.status(202).send({ id: req.params.id, version: version.version, status: version.status });
  });

  app.get<{ Params: { id: string; version: string } }>("/documents/:id/versions/:version/runs", async (req) => ({
    runs: await listRuns(db, req.params.id, versionNumber(req.params.version)),
  }));

  app.get<{ Params: { id: string; version: string } }>("/documents/:id/versions/:version/file", async (req, reply) => {
    const { pdf, fileName } = await getPdf(db, req.params.id, versionNumber(req.params.version));
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="${fileName.replace(/"/g, "")}"`)
      .send(pdf);
  });
}
