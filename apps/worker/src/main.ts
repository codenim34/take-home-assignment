import { Worker } from "bullmq";
import pino from "pino";
import { createDb } from "@lomi/db";
import { createExtractor } from "@lomi/extraction";
import { EXTRACTION_QUEUE, ExtractionQueue, redisConnection, type ExtractionJob } from "@lomi/queue";
import { defaultConfig, processVersion } from "./process.js";
import { reconcileOnce } from "./reconciler.js";

const log = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });
const RECONCILE_MS = Number(process.env.RECONCILE_MS ?? 10_000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);

async function main() {
  const { db, close: closeDb } = createDb();
  const extractor = createExtractor();
  const connection = redisConnection();
  const queue = new ExtractionQueue(connection);
  const shutdown = new AbortController();
  const deps = { db, extractor, log, config: defaultConfig, shutdownSignal: shutdown.signal };

  const worker = new Worker<ExtractionJob>(
    EXTRACTION_QUEUE,
    async (job) => processVersion(deps, job.data.versionId),
    { connection: redisConnection(), concurrency: CONCURRENCY, autorun: true },
  );
  worker.on("error", (err) => log.error({ err }, "bullmq worker error"));

  const sweep = async () => {
    try {
      await reconcileOnce(db, queue, defaultConfig.maxAttempts, log);
    } catch (err) {
      // Redis or Postgres down: keep going, the next sweep will catch up.
      log.error({ err: (err as Error).message }, "reconcile failed");
    }
  };
  await sweep();
  const timer = setInterval(sweep, RECONCILE_MS);
  log.info({ model: extractor.model, concurrency: CONCURRENCY }, "worker started");

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down: handing in-flight work back to the queue");
    clearInterval(timer);
    shutdown.abort();
    await worker.close();
    await queue.close();
    connection.disconnect();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "worker crashed on startup");
  process.exit(1);
});
