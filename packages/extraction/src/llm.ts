import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { CandidateValue, DocumentType, FieldDef } from "@lomi/core";

export interface ExtractRequest {
  documentType: DocumentType;
  fields: readonly FieldDef[];
  text: string;
  signal?: AbortSignal;
}

export interface ExtractResult {
  model: string;
  candidates: Record<string, CandidateValue>;
  /** What we sent, stored per run for debugging. */
  prompt: unknown;
  /** What came back, stored per run for debugging. */
  rawResponse: unknown;
}

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
export function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Reads Retry-After (seconds) from an SDK error's headers, if any. */
export function retryAfterMs(headers: unknown): number | undefined {
  const get = (k: string): string | null | undefined =>
    headers && typeof (headers as Headers).get === "function"
      ? (headers as Headers).get(k)
      : (headers as Record<string, string> | undefined)?.[k];
  const v = get("retry-after");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

export function httpLlmError(provider: string, status: number | undefined, message: string, prompt: unknown, headers?: unknown) {
  return new LlmError(
    `${provider} request failed (${status ?? "network"}): ${message}`,
    prompt,
    undefined,
    isRetryableStatus(status) ? { retryable: true, afterMs: retryAfterMs(headers) } : undefined,
  );
}

export interface Extractor {
  readonly model: string;
  extract(req: ExtractRequest): Promise<ExtractResult>;
}

const FORMAT_HINT: Record<FieldDef["type"], string> = {
  string: "the text as written",
  date: "ISO date YYYY-MM-DD",
  money: "plain decimal number without currency symbol or thousands separators, e.g. 1234.50",
  number: "plain number, e.g. 24",
  percent: "plain number without %, e.g. 4.2",
};

const SYSTEM = `You extract fields from business documents for a human review queue.
Rules:
- For each field return "value" and "evidence".
- "evidence" MUST be copied character-for-character from the document: one short contiguous passage (normally the single line) that states the value, INCLUDING its label (e.g. "Due Date: 2025-10-14", not just "2025-10-14"). Do not paraphrase, reformat, fix typos, or join separate lines. It will be checked by exact string match and discarded if it differs.
- If the document does not state a field, set value and evidence to null and explain why in "reason". Never guess or compute a value that is not written in the document.
- Format "value" as requested per field.`;

export function buildPrompt(req: ExtractRequest) {
  const fieldList = req.fields.map((f) => `- ${f.field} (${f.type}): ${FORMAT_HINT[f.type]}`).join("\n");
  const user = `Document type: ${req.documentType}

Fields to extract:
${fieldList}

<document>
${req.text}
</document>`;
  return { system: SYSTEM, user };
}

export function buildSchema(fields: readonly FieldDef[]) {
  const item = z.object({
    value: z.string().nullable(),
    evidence: z.string().nullable(),
    reason: z.string().nullable(),
  });
  return z.object(Object.fromEntries(fields.map((f) => [f.field, item])));
}

export class AnthropicExtractor implements Extractor {
  private client: Anthropic | null;

  constructor(
    public readonly model: string,
    opts: { apiKey?: string; timeoutMs?: number; baseURL?: string } = {},
  ) {
    // Without a key the worker still starts; each extraction fails visibly instead.
    // Hard per-request timeout; the worker's lease is kept alive by heartbeats meanwhile.
    this.client = opts.apiKey
      ? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 })
      : null;
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const { system, user } = buildPrompt(req);
    const prompt = { model: this.model, system, messages: [{ role: "user", content: user }] };
    if (!this.client) {
      throw new LlmError("ANTHROPIC_API_KEY is not set. Add it to .env (or set LLM_PROVIDER=fake) and retry.", prompt);
    }
    let response;
    try {
      response = await this.client.beta.messages.parse(
        {
          model: this.model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low", format: betaZodOutputFormat(buildSchema(req.fields)) },
          // On a safety decline, let the API re-run on a fallback model instead of failing.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw err;
      if (err instanceof Anthropic.APIError) {
        throw httpLlmError("Anthropic", err.status, err.message, prompt, err.headers);
      }
      throw new LlmError(`LLM output could not be parsed: ${(err as Error).message}`, prompt);
    }
    const raw = { id: response.id, model: response.model, stop_reason: response.stop_reason, content: response.content, usage: response.usage };
    if (response.stop_reason === "refusal") throw new LlmError("The model declined to process this document", prompt, raw);
    if (response.stop_reason === "max_tokens") throw new LlmError("The model's answer was cut off (max_tokens)", prompt, raw);
    if (!response.parsed_output) throw new LlmError("The model returned output that did not match the schema", prompt, raw);
    return {
      model: response.model,
      candidates: response.parsed_output as Record<string, CandidateValue>,
      prompt,
      rawResponse: raw,
    };
  }
}
