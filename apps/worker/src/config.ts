import { hostname } from "node:os";

export interface WorkerConfig {
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  /** Backoff base for transient LLM errors without a Retry-After hint. */
  retryBaseMs: number;
  /** Stable identity of this worker (container hostname by default). */
  workerId?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    leaseMs: Number(env.LEASE_MS ?? 30_000),
    heartbeatMs: Number(env.HEARTBEAT_MS ?? 10_000),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 3),
    retryBaseMs: Number(env.RETRY_BASE_MS ?? 20_000),
    workerId: env.WORKER_ID ?? hostname(),
  };
}
