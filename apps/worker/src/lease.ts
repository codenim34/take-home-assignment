import type { ExtractionStore, RunRef } from "@lomi/core";
import type { Logger } from "pino";

/**
 * Keeps the run's lease alive while the LLM call is in flight. If a renewal
 * finds that the run no longer owns the version (a newer upload superseded
 * it, or the reconciler reclaimed it after a stall), `onLost` fires once so
 * the pipeline can abort the call early. A failed renewal (database blip) is
 * only logged: the lease is long enough to survive a missed beat.
 */
export function holdLease(
  store: Pick<ExtractionStore, "renewLease">,
  run: RunRef,
  opts: { leaseMs: number; heartbeatMs: number; log: Logger; onLost: () => void },
): { release(): void } {
  let lost = false;
  const timer = setInterval(async () => {
    try {
      if (!lost && !(await store.renewLease(run, opts.leaseMs))) {
        lost = true;
        opts.log.warn("lost ownership (superseded or reclaimed); aborting");
        opts.onLost();
      }
    } catch (err) {
      opts.log.warn({ err }, "heartbeat failed");
    }
  }, opts.heartbeatMs);
  return { release: () => clearInterval(timer) };
}
