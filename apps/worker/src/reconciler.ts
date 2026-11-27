import { reconcile, type Db } from "@lomi/db";
import type { ExtractionQueue } from "@lomi/queue";
import type { Logger } from "pino";

/**
 * Brings Redis back in line with Postgres. Idempotent, so it is safe to run
 * on every worker, at startup and on a timer:
 *   - expired leases (dead worker) go back to queued, or failed when out of attempts;
 *   - every queued version is (re-)enqueued; BullMQ dedupes by jobId.
 * This is the whole answer to "Redis was flushed" and "a container was killed".
 */
export async function reconcileOnce(db: Db, queue: ExtractionQueue, maxAttempts: number, log: Logger) {
  const result = await reconcile(db, maxAttempts);
  for (const v of result.queued) await queue.enqueue(v.id, v.attempts);
  if (result.requeued.length || result.failed.length) {
    log.warn({ requeued: result.requeued, failed: result.failed }, "recovered versions with expired leases");
  }
  return result;
}
