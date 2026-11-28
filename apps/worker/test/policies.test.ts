import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { LlmError, PdfParseError } from "@lomi/extraction";
import { classifyFailure, LostOwnership } from "../src/failure-policy.js";
import { holdLease } from "../src/lease.js";
import { retryDelayMs } from "../src/retry-policy.js";

const ctx = { shuttingDown: false, attempt: 1, retryBaseMs: 20_000 };
const retryable = (afterMs?: number) => new LlmError("429", null, null, { retryable: true, afterMs });

describe("retryDelayMs", () => {
  it("backs off exponentially from the base", () => {
    expect([1, 2, 3].map((a) => retryDelayMs(a, 20_000))).toEqual([20_000, 40_000, 80_000]);
  });
  it("prefers the provider's hint", () => {
    expect(retryDelayMs(3, 20_000, 31_000)).toBe(31_000);
  });
  it("never waits more than 5 minutes", () => {
    expect(retryDelayMs(10, 20_000)).toBe(300_000);
    expect(retryDelayMs(1, 20_000, 3_600_000)).toBe(300_000);
  });
});

describe("classifyFailure", () => {
  it("a lost lease beats any error the aborted call threw", () => {
    expect(classifyFailure(retryable(), { ...ctx, abortReason: new LostOwnership() })).toEqual({ kind: "lost_ownership" });
  });
  it("shutdown hands the version back", () => {
    expect(classifyFailure(new Error("aborted"), { ...ctx, abortReason: new Error("shutdown"), shuttingDown: true })).toEqual({
      kind: "release",
    });
  });
  it("retryable LLM errors are retried with backoff", () => {
    expect(classifyFailure(retryable(), { ...ctx, attempt: 2 })).toEqual({ kind: "retry", delayMs: 40_000, message: "429" });
    expect(classifyFailure(retryable(5000), ctx)).toMatchObject({ kind: "retry", delayMs: 5000 });
  });
  it("bad PDFs and non-retryable LLM errors fail with their own message", () => {
    expect(classifyFailure(new PdfParseError("no text"), ctx)).toEqual({ kind: "fail", message: "no text" });
    expect(classifyFailure(new LlmError("refused"), ctx)).toEqual({ kind: "fail", message: "refused" });
  });
  it("anything else is an unexpected failure, still a state, never a crash", () => {
    expect(classifyFailure(new TypeError("boom"), ctx)).toEqual({ kind: "fail", message: "Unexpected error: boom" });
  });
});

describe("holdLease", () => {
  afterEach(() => vi.useRealTimers());
  const log = pino({ level: "silent" });
  const run = { versionId: "v", runId: "r" };

  it("renews on every beat and calls onLost once when ownership is gone", async () => {
    vi.useFakeTimers();
    const answers = [true, false, false];
    const store = { renewLease: vi.fn(async () => answers.shift() ?? false) };
    const onLost = vi.fn();
    const lease = holdLease(store, run, { leaseMs: 30_000, heartbeatMs: 100, log, onLost });
    await vi.advanceTimersByTimeAsync(350);
    lease.release();
    expect(store.renewLease).toHaveBeenCalledTimes(2);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("a failed renewal (db blip) is not treated as lost ownership", async () => {
    vi.useFakeTimers();
    const store = { renewLease: vi.fn(async () => Promise.reject(new Error("connection reset"))) };
    const onLost = vi.fn();
    const lease = holdLease(store, run, { leaseMs: 30_000, heartbeatMs: 100, log, onLost });
    await vi.advanceTimersByTimeAsync(250);
    lease.release();
    expect(store.renewLease).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
  });
});
