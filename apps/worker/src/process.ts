import { fieldsFor, isDocumentType, validateCandidate } from "@lomi/core";
import {
  claimVersion,
  commitExtraction,
  failRun,
  getVersionForExtraction,
  heartbeat,
  recordRunIO,
  type Db,
} from "@lomi/db";
import { LlmError, PdfParseError, parsePdf, type Extractor } from "@lomi/extraction";
import { hostname } from "node:os";
import type { Logger } from "pino";

export interface WorkerConfig {
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  /** Backoff base for transient LLM errors without a Retry-After hint. */
  retryBaseMs: number;
  /** Stable identity of this worker (container hostname by default). */
  workerId?: string;
}

export const defaultConfig: WorkerConfig = {
  leaseMs: Number(process.env.LEASE_MS ?? 30_000),
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 10_000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS ?? 20_000),
  workerId: process.env.WORKER_ID ?? hostname(),
};

export interface Deps {
  db: Db;
  extractor: Extractor;
  log: Logger;
  config: WorkerConfig;
  /** Aborted on graceful shutdown: in-flight runs hand their attempt back. */
  shutdownSignal?: AbortSignal;
}

export type ProcessOutcome =
  | "not_claimed"
  | "extracted"
  | "failed"
  | "retry_scheduled"
  | "requeued_on_shutdown"
  | "lost_ownership";

class LostOwnership extends Error {}

/**
 * Process one version end to end. Safe to call any number of times, from any
 * number of workers, for the same version: only the run that claims it can
 * commit, and the commit is all-or-nothing.
 */
export async function processVersion(deps: Deps, versionId: string): Promise<ProcessOutcome> {
  const { db, extractor, log, config } = deps;
  const claim = await claimVersion(db, versionId, {
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    model: extractor.model,
    workerId: config.workerId,
  });
  if (!claim) {
    log.debug({ versionId }, "not claimable (already taken, done, or superseded)");
    return "not_claimed";
  }
  const { runId } = claim;
  const runLog = log.child({ versionId, runId, attempt: claim.version.attempts });
  runLog.info("claimed");

  // One controller for both reasons to stop: shutdown, or we lost the lease.
  const ac = new AbortController();
  const onShutdown = () => ac.abort(new Error("shutdown"));
  deps.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  const hb = setInterval(async () => {
    try {
      if (!(await heartbeat(db, versionId, runId, config.leaseMs))) {
        runLog.warn("lost ownership (superseded or reclaimed); aborting");
        ac.abort(new LostOwnership("lost ownership"));
      }
    } catch (err) {
      runLog.warn({ err }, "heartbeat failed");
    }
  }, config.heartbeatMs);

  let parsedText: string | undefined;
  try {
    const row = await getVersionForExtraction(db, versionId);
    if (!row || !isDocumentType(row.type)) throw new Error(`Unknown document type for version ${versionId}`);
    parsedText = await parsePdf(row.version.pdf);
    const fields = fieldsFor(row.type);

    let result;
    try {
      result = await extractor.extract({ documentType: row.type, fields, text: parsedText, signal: ac.signal });
    } catch (err) {
      if (err instanceof LlmError) await recordRunIO(db, runId, { prompt: err.prompt, rawResponse: err.rawResponse });
      throw err;
    }
    await recordRunIO(db, runId, { model: result.model, prompt: result.prompt, rawResponse: result.rawResponse });
    if (ac.signal.aborted) throw ac.signal.reason;

    const values = fields.map((f) => validateCandidate(f, result.candidates[f.field], parsedText!));
    const commit = await commitExtraction(db, { versionId, runId, parsedText, values });
    if (!commit.committed) {
      runLog.warn({ reason: commit.reason }, "result discarded by guarded commit");
      return "lost_ownership";
    }
    runLog.info({ values: commit.values, carried: commit.carried, gaps: values.filter((v) => !v.value).length }, "extracted");
    return "extracted";
  } catch (err) {
    if (ac.signal.aborted && ac.signal.reason instanceof LostOwnership) return "lost_ownership";
    if (ac.signal.aborted && deps.shutdownSignal?.aborted) {
      await failRun(db, { versionId, runId, error: "Worker shut down mid-extraction", requeue: true });
      runLog.info("handed back to the queue on shutdown");
      return "requeued_on_shutdown";
    }
    if (err instanceof LlmError && err.retryable) {
      // Rate limit / overload / network: durable backoff in Postgres, not a crash loop.
      const attempt = claim.version.attempts;
      const delay = Math.min(err.retry?.afterMs ?? config.retryBaseMs * 2 ** (attempt - 1), 5 * 60_000);
      const owned = await failRun(db, {
        versionId,
        runId,
        error: err.message,
        retryAfterMs: delay,
        maxAttempts: config.maxAttempts,
      });
      runLog.warn({ err: err.message, retryInMs: delay, owned }, "transient LLM error; re-queued with backoff");
      return owned ? "retry_scheduled" : "lost_ownership";
    }
    const message =
      err instanceof PdfParseError || err instanceof LlmError
        ? err.message
        : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
    const owned = await failRun(db, { versionId, runId, error: message, parsedText });
    runLog.error({ err: message, owned }, "extraction failed");
    return owned ? "failed" : "lost_ownership";
  } finally {
    clearInterval(hb);
    deps.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}
