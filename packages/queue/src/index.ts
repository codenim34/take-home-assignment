import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";

/**
 * Redis holds only "version X needs work" messages. Nothing here is the source
 * of truth: the reconciler can rebuild the whole queue from Postgres, which is
 * why a FLUSHALL loses nothing.
 */
export const EXTRACTION_QUEUE = "extraction";

export interface ExtractionJob {
  versionId: string;
}

export function redisConnection(url = process.env.REDIS_URL ?? "redis://localhost:6379"): Redis {
  // maxRetriesPerRequest: null is required by BullMQ workers (blocking commands).
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * jobId = versionId + attempt number. BullMQ ignores an add() whose jobId
 * already exists, which dedupes repeated enqueues of the same attempt (the
 * reconciler re-enqueues every queued version on every sweep). Including the
 * attempt means a re-queue after a crash is a NEW job and can't be swallowed
 * by a stale job left in Redis. Completed/failed jobs are removed anyway.
 */
export function jobIdFor(versionId: string, attempts: number): string {
  return `${versionId}-a${attempts}`;
}

export class ExtractionQueue {
  readonly queue: Queue<ExtractionJob>;
  constructor(connection: ConnectionOptions) {
    this.queue = new Queue<ExtractionJob>(EXTRACTION_QUEUE, {
      connection,
      defaultJobOptions: {
        // Retries are owned by Postgres (attempts column + reconciler), not BullMQ.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  }

  async enqueue(versionId: string, attempts: number): Promise<void> {
    await this.queue.add("extract", { versionId }, { jobId: jobIdFor(versionId, attempts) });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
