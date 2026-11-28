import type { CandidateValue, ExtractRequest, ExtractResult, Extractor } from "@lomi/core";
import { LlmError, httpLlmError } from "./errors.js";
import { buildPrompt, buildSchema, toJsonSchema, type CandidateSchema } from "./prompt.js";

/** Everything a provider needs to make its call; built once by the base class. */
export interface PromptParts {
  system: string;
  user: string;
  schema: CandidateSchema;
  jsonSchema: Record<string, unknown>;
}

/** A provider's answer, reduced to what the base class checks. */
export interface ProviderReply {
  /** Model that actually answered (may differ from the requested one). */
  model: string;
  /** Stored on the run for debugging. */
  raw: unknown;
  /** Set when the provider says the answer is unusable (refusal, cut off, blocked). */
  problem?: string;
  /** The structured answer: a JSON string, or an already-parsed object. */
  output: unknown;
}

/**
 * Template Method for every structured-output LLM provider. The fixed
 * skeleton lives here: same prompt, same schema, missing-key handling, abort
 * handling, JSON parsing and schema validation. A provider only fills in how
 * to call its SDK (`send`) and how to read its errors (`toLlmError`), so
 * adding one never touches this file or the evidence checks downstream.
 */
export abstract class StructuredExtractor<Client> implements Extractor {
  /** Human name used in error messages, e.g. "Gemini". */
  protected abstract readonly provider: string;
  /** Env var that holds the key, named in the "not set" error. */
  protected abstract readonly apiKeyEnv: string;

  protected constructor(
    public readonly model: string,
    /** Null when no API key is configured: the worker still starts, each run fails visibly. */
    private readonly client: Client | null,
  ) {}

  /** What gets stored as the run's prompt. */
  protected abstract describeRequest(parts: PromptParts): unknown;
  protected abstract send(client: Client, parts: PromptParts, signal?: AbortSignal): Promise<ProviderReply>;
  /** Map an SDK error to an LlmError. The default treats it as a network failure (retryable). */
  protected toLlmError(err: unknown, prompt: unknown): LlmError {
    return httpLlmError(this.provider, undefined, (err as Error)?.message ?? String(err), prompt);
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const schema = buildSchema(req.fields);
    const parts: PromptParts = { ...buildPrompt(req), schema, jsonSchema: toJsonSchema(schema) };
    const prompt = this.describeRequest(parts);
    if (!this.client) {
      throw new LlmError(`${this.apiKeyEnv} is not set. Add it to .env (or set LLM_PROVIDER=fake) and retry.`, prompt);
    }

    let reply: ProviderReply;
    try {
      reply = await this.send(this.client, parts, req.signal);
    } catch (err) {
      // Shutdown or lost lease: let the caller see its own abort reason, not an LLM error.
      if (req.signal?.aborted) throw req.signal.reason;
      throw err instanceof LlmError ? err : this.toLlmError(err, prompt);
    }
    if (reply.problem) throw new LlmError(reply.problem, prompt, reply.raw);

    let parsed = reply.output;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new LlmError("The model returned output that is not valid JSON", prompt, reply.raw);
      }
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new LlmError(`The model returned output that did not match the schema: ${result.error.message}`, prompt, reply.raw);
    }
    return {
      model: reply.model,
      candidates: result.data as Record<string, CandidateValue>,
      prompt,
      rawResponse: reply.raw,
    };
  }
}
