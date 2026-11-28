import { fieldsFor, validateCandidate, type ExtractionStore, type Extractor, type RunRef } from "@lomi/core";
import { LlmError, parsePdf } from "@lomi/extraction";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config.js";
import { classifyFailure, LostOwnership, type FailureDecision } from "./failure-policy.js";
import { holdLease } from "./lease.js";

export interface Deps {
  store: ExtractionStore;
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

/**
 * Process one version end to end:
 *   claim -> hold lease -> parse PDF -> LLM -> validate evidence -> guarded commit.
 * Safe to call any number of times, from any number of workers, for the same
 * version: only the run that claims it can commit, and the commit is
 * all-or-nothing. Depends only on ports, never on Postgres or an LLM SDK.
 */
export async function processVersion(deps: Deps, versionId: string): Promise<ProcessOutcome> {
  const { store, extractor, log, config } = deps;
  const claim = await store.claim(versionId, {
    leaseMs: config.leaseMs,
    maxAttempts: config.maxAttempts,
    model: extractor.model,
    workerId: config.workerId,
  });
  if (!claim) {
    log.debug({ versionId }, "not claimable (already taken, done, or superseded)");
    return "not_claimed";
  }
  const run: RunRef = { versionId, runId: claim.runId };
  const { documentType, pdf, attempt } = claim.version;
  const runLog = log.child({ versionId, runId: run.runId, attempt });
  runLog.info("claimed");

  // One controller for both reasons to stop early: shutdown, or a lost lease.
  const ac = new AbortController();
  const onShutdown = () => ac.abort(new Error("shutdown"));
  deps.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  const lease = holdLease(store, run, {
    leaseMs: config.leaseMs,
    heartbeatMs: config.heartbeatMs,
    log: runLog,
    onLost: () => ac.abort(new LostOwnership()),
  });

  let parsedText: string | undefined;
  try {
    parsedText = await parsePdf(pdf);
    const fields = fieldsFor(documentType);
    const result = await extractor
      .extract({ documentType, fields, text: parsedText, signal: ac.signal })
      .catch(async (err: unknown) => {
        if (err instanceof LlmError) await store.recordRunIO(run.runId, { prompt: err.prompt, rawResponse: err.rawResponse });
        throw err;
      });
    await store.recordRunIO(run.runId, { model: result.model, prompt: result.prompt, rawResponse: result.rawResponse });
    if (ac.signal.aborted) throw ac.signal.reason;

    const text = parsedText;
    const values = fields.map((f) => validateCandidate(f, result.candidates[f.field], text));
    const commit = await store.commit(run, { parsedText: text, values });
    if (!commit.committed) {
      runLog.warn({ reason: commit.reason }, "result discarded by guarded commit");
      return "lost_ownership";
    }
    runLog.info({ values: commit.values, carried: commit.carried, gaps: values.filter((v) => !v.value).length }, "extracted");
    return "extracted";
  } catch (err) {
    const decision = classifyFailure(err, {
      abortReason: ac.signal.aborted ? ac.signal.reason : undefined,
      shuttingDown: deps.shutdownSignal?.aborted ?? false,
      attempt,
      retryBaseMs: config.retryBaseMs,
    });
    return await applyFailure(deps, run, runLog, decision, parsedText);
  } finally {
    lease.release();
    deps.shutdownSignal?.removeEventListener("abort", onShutdown);
  }
}

/** Carries out the failure policy's decision through the store. */
async function applyFailure(
  { store, config }: Deps,
  run: RunRef,
  runLog: Logger,
  decision: FailureDecision,
  parsedText: string | undefined,
): Promise<ProcessOutcome> {
  switch (decision.kind) {
    case "lost_ownership":
      return "lost_ownership";
    case "release":
      await store.releaseForShutdown(run);
      runLog.info("handed back to the queue on shutdown");
      return "requeued_on_shutdown";
    case "retry": {
      const owned = await store.scheduleRetry(run, decision.message, decision.delayMs, config.maxAttempts);
      runLog.warn({ err: decision.message, retryInMs: decision.delayMs, owned }, "transient LLM error; re-queued with backoff");
      return owned ? "retry_scheduled" : "lost_ownership";
    }
    case "fail": {
      const owned = await store.markFailed(run, decision.message, parsedText);
      runLog.error({ err: decision.message, owned }, "extraction failed");
      return owned ? "failed" : "lost_ownership";
    }
  }
}
