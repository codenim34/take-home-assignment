import type { JobQueue } from "@lomi/core";
import type { FastifyBaseLogger } from "fastify";

/**
 * Decorator around any JobQueue: same interface, but enqueue never throws and
 * never takes longer than `timeoutMs`. Postgres has already committed when it
 * runs, so if Redis is down the upload still succeeds: the version is
 * `queued` in Postgres and the worker's reconciler enqueues it later. Redis
 * is never on the request's critical path.
 */
export class BestEffortQueue implements JobQueue {
  constructor(
    private readonly inner: JobQueue,
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs = 1000,
  ) {}

  async enqueue(versionId: string, attempts: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.inner.enqueue(versionId, attempts),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("enqueue timeout")), this.timeoutMs);
        }),
      ]);
    } catch (err) {
      this.log.warn({ versionId, err: (err as Error).message }, "enqueue failed; reconciler will pick it up");
    } finally {
      clearTimeout(timer);
    }
  }
}
