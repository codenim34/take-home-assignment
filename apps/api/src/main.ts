import { createDb } from "@lomi/db";
import { ExtractionQueue } from "@lomi/queue";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";

const { db, close } = createDb();
// Fail fast instead of buffering when Redis is down: the API must not hang on
// Redis, and the reconciler covers anything that wasn't enqueued.
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
redis.on("error", () => {});
const queue = new ExtractionQueue(redis);
const app = await buildApp({ db, queue });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

const stop = async () => {
  await app.close();
  await queue.close();
  redis.disconnect();
  await close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
