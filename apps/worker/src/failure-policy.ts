import { LlmError, PdfParseError } from "@lomi/extraction";
import { retryDelayMs } from "./retry-policy.js";

/** Why the run's abort signal fired. */
export class LostOwnership extends Error {
  constructor() {
    super("lost ownership");
  }
}

export type FailureDecision =
  /** The run no longer owns the version (superseded, reclaimed): touch nothing. */
  | { kind: "lost_ownership" }
  /** Graceful shutdown: hand the version back with the attempt refunded. */
  | { kind: "release" }
  /** Transient (rate limit, overload, network): re-queue after a delay, spending the attempt. */
  | { kind: "retry"; delayMs: number; message: string }
  /** Permanent: the version becomes `failed` with this message. */
  | { kind: "fail"; message: string };

/**
 * One pure function decides what an error means for the version, so the
 * pipeline has no if-chains about error types and the policy can be unit
 * tested without Postgres. Order matters: an abort caused by shutdown or a
 * lost lease beats whatever error the aborted call happened to throw.
 */
export function classifyFailure(
  err: unknown,
  ctx: { abortReason?: unknown; shuttingDown: boolean; attempt: number; retryBaseMs: number },
): FailureDecision {
  if (ctx.abortReason instanceof LostOwnership) return { kind: "lost_ownership" };
  if (ctx.abortReason !== undefined && ctx.shuttingDown) return { kind: "release" };
  if (err instanceof LlmError && err.retryable) {
    return { kind: "retry", delayMs: retryDelayMs(ctx.attempt, ctx.retryBaseMs, err.retry?.afterMs), message: err.message };
  }
  if (err instanceof PdfParseError || err instanceof LlmError) return { kind: "fail", message: err.message };
  return { kind: "fail", message: `Unexpected error: ${(err as Error)?.message ?? String(err)}` };
}
