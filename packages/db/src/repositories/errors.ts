/** A failure the caller caused (bad input, wrong state, missing row). The API maps `code` to an HTTP status. */
export class DomainError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
