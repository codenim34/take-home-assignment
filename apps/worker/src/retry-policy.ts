const MAX_DELAY_MS = 5 * 60_000;

/**
 * How long to wait before attempt `attempt + 1` after a transient LLM error.
 * The provider's own hint (Retry-After, Gemini retryDelay) wins; otherwise
 * exponential backoff: base, 2x base, 4x base... Always capped at 5 minutes,
 * so a silly hint can't park a document for an hour.
 */
export function retryDelayMs(attempt: number, baseMs: number, hintMs?: number): number {
  const delay = hintMs ?? baseMs * 2 ** Math.max(attempt - 1, 0);
  return Math.min(delay, MAX_DELAY_MS);
}
