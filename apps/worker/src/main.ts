import { Worker } from "bullmq";
import pino from "pino";
import { createDb, PgExtractionStore } from "@lomi/db";
import { createExtractor } from "@lomi/extraction";
import { EXTRACTION_QUEUE, ExtractionQueue, redisConnection, type ExtractionJob } from "@lomi/queue";
import { configFromEnv } from "./config.js";
import { processVersion } from "./pipeline.js";
import { reconcileOnce } from "./reconciler.js";

const log = pino({ name: "worker", level: process.env.LOG_LEVEL ?? "info" });
const RECONCILE_MS = Number(process.env.RECONCILE_MS ?? 10_000);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);

/** Composition root: the only place that knows which adapters implement the ports. */
async function main() {
  const config = configFromEnv();
  const { db, close: closeDb } = createDb();
  const store = new PgExtractionStore(db);
  const extractor = createExtractor();
  const connection = redisConnection();
  connection.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));
  const queue = new ExtractionQueue(connection);
  const shutdown = new AbortController();
  const deps = { store, extractor, log, config, shutdownSignal: shutdown.signal };

  const workerConnection = redisConnection();
  workerConnection.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));
  const worker = new Worker<ExtractionJob>(
    EXTRACTION_QUEUE,
    async (job) => processVersion(deps, job.data.versionId),
    { connection: workerConnection, concurrency: CONCURRENCY, autorun: true },
  );
  worker.on("error", (err) => log.error({ err }, "bullmq worker error"));

  const sweep = async () => {
    try {
      await reconcileOnce(store, queue, config.maxAttempts, log);
    } catch (err) {
      // Redis or Postgres down: keep going, the next sweep will catch up.
      log.error({ err: (err as Error).message }, "reconcile failed");
    }
  };
  // Runs left "running" by this worker's previous life are dead: recover them now.
  const orphans = await store.expireOrphanedLeases(config.workerId!);
  if (orphans.length) log.warn({ orphans }, "recovering runs orphaned by this worker's previous process");
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
    // Bounded: if Redis/Postgres are already gone (whole stack stopping), don't hang.
    // Anything not handed back is recovered at next startup via expireOrphanedLeases.
    await Promise.race([
      Promise.allSettled([worker.close(), queue.close()]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    connection.disconnect();
    await Promise.race([closeDb(), new Promise((r) => setTimeout(r, 2000))]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "worker crashed on startup");
  process.exit(1);
});
