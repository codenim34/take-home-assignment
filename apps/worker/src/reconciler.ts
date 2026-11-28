import type { JobQueue, RecoveryStore } from "@lomi/core";
import type { Logger } from "pino";

/**
 * Brings Redis back in line with Postgres. Idempotent, so it is safe to run
 * on every worker, at startup and on a timer:
 *   - expired leases (dead worker) go back to queued, or failed when out of attempts;
 *   - every due queued version is (re-)enqueued; the queue dedupes by job id.
 * This is the whole answer to "Redis was flushed" and "a container was killed".
 */
export async function reconcileOnce(store: RecoveryStore, queue: JobQueue, maxAttempts: number, log: Logger) {
  const result = await store.reconcile(maxAttempts);
  for (const v of result.queued) await queue.enqueue(v.id, v.attempts);
  if (result.requeued.length || result.failed.length) {
    log.warn({ requeued: result.requeued, failed: result.failed }, "recovered versions with expired leases");
  }
  return result;
}
