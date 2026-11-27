import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { DOCUMENT_TYPES } from "@lomi/core";
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
  reviewValue,
  type Db,
} from "@lomi/db";

export interface Enqueuer {
  enqueue(versionId: string, attempts: number): Promise<void>;
}

export interface AppDeps {
  db: Db;
  queue: Enqueuer;
  logger?: boolean | object;
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;

const reviewBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(2000).nullish(), reviewer: z.string().max(200).nullish() }),
  z.object({
    action: z.literal("correct"),
    value: z.string().min(1).max(2000),
    note: z.string().max(2000).nullish(),
    reviewer: z.string().max(200).nullish(),
  }),
]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_PDF_BYTES, files: 1 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      const status = { not_found: 404, conflict: 409, invalid: 400 }[err.code];
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid", message: err.issues.map((i) => i.message).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: "error", message: (err as Error).message });
  });

  /**
   * Postgres has already committed when this runs. If Redis is down the
   * upload still succeeds: the version is `queued` in Postgres and the
   * worker's reconciler will enqueue it. Redis is never on the critical path.
   */
  async function enqueueBestEffort(versionId: string, attempts: number) {
    try {
      await Promise.race([
        deps.queue.enqueue(versionId, attempts),
        new Promise((_, rej) => setTimeout(() => rej(new Error("enqueue timeout")), 1000)),
      ]);
    } catch (err) {
      app.log.warn({ versionId, err: (err as Error).message }, "enqueue failed; reconciler will pick it up");
    }
  }

  async function readUpload(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let file: { fileName: string; pdf: Buffer } | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        file = { fileName: part.filename || "upload.pdf", pdf: buf };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!file) throw new DomainError("invalid", 'Missing "file" part');
    if (file.pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DomainError("invalid", "File is not a PDF");
    return { fields, file };
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/documents", async () => ({ documents: await listDocuments(deps.db) }));

  app.post("/documents", async (req, reply) => {
    const { fields, file } = await readUpload(req);
    const type = fields.type;
    if (!type || !(DOCUMENT_TYPES as readonly string[]).includes(type)) {
      throw new DomainError("invalid", `"type" must be one of ${DOCUMENT_TYPES.join(", ")}`);
    }
    const { document, version } = await createDocument(deps.db, { type, title: fields.title, ...file });
    await enqueueBestEffort(version.id, version.attempts);
    return reply.status(202).send({ id: document.id, version: version.version, status: version.status });
  });

  app.post<{ Params: { id: string } }>("/documents/:id/versions", async (req, reply) => {
    const { file } = await readUpload(req);
    const { version, duplicate, superseded } = await addVersion(deps.db, req.params.id, file);
    if (!duplicate) await enqueueBestEffort(version.id, version.attempts);
    return reply.status(duplicate ? 200 : 202).send({
      id: req.params.id,
      version: version.version,
      status: version.status,
      duplicate,
      supersededVersionIds: superseded,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>("/documents/:id", async (req) => {
    const v = req.query.version ? Number(req.query.version) : undefined;
    if (v !== undefined && !Number.isInteger(v)) throw new DomainError("invalid", "version must be an integer");
    return getDocument(deps.db, req.params.id, v);
  });

  app.get<{ Params: { id: string; version: string } }>("/documents/:id/versions/:version", async (req) =>
    getDocument(deps.db, req.params.id, Number(req.params.version)),
  );

  app.get<{ Params: { id: string } }>("/documents/:id/progress", async (req) => getProgress(deps.db, req.params.id));

  app.post<{ Params: { id: string } }>("/documents/:id/retry", async (req, reply) => {
    const version = await retryCurrentVersion(deps.db, req.params.id);
    await enqueueBestEffort(version.id, version.attempts);
    return reply.status(202).send({ id: req.params.id, version: version.version, status: version.status });
  });

  app.get<{ Params: { id: string; version: string } }>("/documents/:id/versions/:version/runs", async (req) => ({
    runs: await listRuns(deps.db, req.params.id, Number(req.params.version)),
  }));

  app.get<{ Params: { id: string; version: string } }>(
    "/documents/:id/versions/:version/file",
    async (req, reply: FastifyReply) => {
      const { pdf, fileName } = await getPdf(deps.db, req.params.id, Number(req.params.version));
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `inline; filename="${fileName.replace(/"/g, "")}"`)
        .send(pdf);
    },
  );

  app.post<{ Params: { id: string } }>("/values/:id/review", async (req) => {
    const body = reviewBody.parse(req.body);
    const { value, review } = await reviewValue(deps.db, req.params.id, {
      action: body.action,
      value: body.action === "correct" ? body.value : null,
      note: body.note,
      reviewer: body.reviewer,
    });
    return { value: { id: value.id, reviewState: value.reviewState }, review };
  });

  return app;
}
