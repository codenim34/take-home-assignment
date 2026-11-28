/**
 * Model-side failure. Non-retryable ones leave the version `failed`.
 * Retryable ones (rate limit, overload, network) re-queue the version with a
 * delay, spending one attempt; after the attempt budget it ends up `failed`.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly prompt?: unknown,
    public readonly rawResponse?: unknown,
    public readonly retry?: { retryable: true; afterMs?: number },
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.retry?.retryable === true;
  }
}

/** 429, 408, 409 and 5xx (incl. 529 overloaded) and network errors are worth retrying later. */
function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Reads Retry-After (seconds) from an SDK error's headers, if any. */
function retryAfterFromHeaders(headers: unknown): number | undefined {
  const get = (k: string): string | null | undefined =>
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get(k)
      : (headers as Record<string, string> | undefined)?.[k];
  const v = get("retry-after");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/**
 * The one place that turns a provider's HTTP/network failure into an LlmError
 * and decides whether it is retryable. `status` undefined = network failure.
 */
export function httpLlmError(
  provider: string,
  status: number | undefined,
  message: string,
  prompt: unknown,
  hint: { headers?: unknown; afterMs?: number } = {},
): LlmError {
  return new LlmError(
    `${provider} request failed (${status ?? "network"}): ${message}`,
    prompt,
    undefined,
    isRetryableStatus(status) ? { retryable: true, afterMs: hint.afterMs ?? retryAfterFromHeaders(hint.headers) } : undefined,
  );
}
