import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { JobQueue } from "@lomi/core";
import type { Db } from "@lomi/db";
import { BestEffortQueue } from "./best-effort-queue.js";
import { registerErrorHandler } from "./http/errors.js";
import { MAX_PDF_BYTES } from "./http/upload.js";
import { documentRoutes } from "./routes/documents.js";
import { valueRoutes } from "./routes/values.js";

export interface AppDeps {
  db: Db;
  queue: JobQueue;
  logger?: boolean | object;
}

/** Builds the HTTP app from its dependencies (no globals, so tests inject a recording queue). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: MAX_PDF_BYTES, files: 1 } });
  registerErrorHandler(app);

  const queue = new BestEffortQueue(deps.queue, app.log);
  app.get("/health", async () => ({ ok: true }));
  documentRoutes(app, { db: deps.db, queue });
  valueRoutes(app, { db: deps.db });
  return app;
}
