import Groq from "groq-sdk";
import { httpLlmError, type LlmError } from "../errors.js";
import type { ProviderDefinition } from "../registry.js";
import { StructuredExtractor, type PromptParts, type ProviderReply } from "../structured-extractor.js";

/** Groq (OpenAI-compatible chat API) with strict JSON-schema structured output. */
export class GroqExtractor extends StructuredExtractor<Groq> {
  protected readonly provider = "Groq";
  protected readonly apiKeyEnv = "GROQ_API_KEY";

  constructor(model: string, opts: { apiKey?: string; timeoutMs?: number; baseURL?: string } = {}) {
    // maxRetries 0: rate limits are handled by our own durable retry (re-queue with delay).
    super(
      model,
      opts.apiKey
        ? new Groq({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 })
        : null,
    );
  }

  protected describeRequest(p: PromptParts) {
    return { model: this.model, system: p.system, user: p.user, schema: p.jsonSchema };
  }

  protected async send(client: Groq, p: PromptParts, signal?: AbortSignal): Promise<ProviderReply> {
    const response = await client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: "system", content: p.system },
          { role: "user", content: p.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "extraction", schema: p.jsonSchema, strict: true },
        },
        temperature: 0,
        max_completion_tokens: 4096,
      },
      { signal },
    );
    const choice = response.choices[0];
    const raw = {
      id: response.id,
      model: response.model,
      finish_reason: choice?.finish_reason,
      content: choice?.message.content,
      usage: response.usage,
    };
    const problem = !choice
      ? "The model returned no answer"
      : choice.finish_reason === "length"
        ? "The model's answer was cut off (length)"
        : undefined;
    return { model: response.model, raw, problem, output: choice?.message.content ?? "" };
  }

  protected toLlmError(err: unknown, prompt: unknown): LlmError {
    if (err instanceof Groq.APIError) return httpLlmError(this.provider, err.status, err.message, prompt, { headers: err.headers });
    return super.toLlmError(err, prompt);
  }
}

export const groq: ProviderDefinition = {
  name: "groq",
  defaultModel: "openai/gpt-oss-20b",
  create: ({ model, timeoutMs, env }) =>
    new GroqExtractor(model, { apiKey: env.GROQ_API_KEY || undefined, baseURL: env.GROQ_BASE_URL || undefined, timeoutMs }),
};
