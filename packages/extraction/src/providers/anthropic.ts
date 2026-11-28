import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmError, httpLlmError } from "../errors.js";
import type { ProviderDefinition } from "../registry.js";
import { StructuredExtractor, type PromptParts, type ProviderReply } from "../structured-extractor.js";

/** Claude with structured outputs (messages.parse + a zod output format). */
export class AnthropicExtractor extends StructuredExtractor<Anthropic> {
  protected readonly provider = "Anthropic";
  protected readonly apiKeyEnv = "ANTHROPIC_API_KEY";

  constructor(model: string, opts: { apiKey?: string; timeoutMs?: number; baseURL?: string } = {}) {
    super(
      model,
      opts.apiKey
        ? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 })
        : null,
    );
  }

  protected describeRequest(p: PromptParts) {
    return { model: this.model, system: p.system, messages: [{ role: "user", content: p.user }] };
  }

  protected async send(client: Anthropic, p: PromptParts, signal?: AbortSignal): Promise<ProviderReply> {
    const response = await client.beta.messages.parse(
      {
        model: this.model,
        max_tokens: 4096,
        system: p.system,
        messages: [{ role: "user", content: p.user }],
        output_config: { effort: "low", format: betaZodOutputFormat(p.schema) },
        // On a safety decline, let the API re-run on a fallback model instead of failing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    const raw = {
      id: response.id,
      model: response.model,
      stop_reason: response.stop_reason,
      content: response.content,
      usage: response.usage,
    };
    const problem =
      response.stop_reason === "refusal"
        ? "The model declined to process this document"
        : response.stop_reason === "max_tokens"
          ? "The model's answer was cut off (max_tokens)"
          : undefined;
    return { model: response.model, raw, problem, output: response.parsed_output };
  }

  protected toLlmError(err: unknown, prompt: unknown): LlmError {
    if (err instanceof Anthropic.APIError) {
      return httpLlmError(this.provider, err.status, err.message, prompt, { headers: err.headers });
    }
    // messages.parse throws a plain error when the output does not match the schema.
    return new LlmError(`LLM output could not be parsed: ${(err as Error).message}`, prompt);
  }
}

export const anthropic: ProviderDefinition = {
  name: "anthropic",
  defaultModel: "claude-sonnet-5-5",
  create: ({ model, timeoutMs, env }) =>
    new AnthropicExtractor(model, {
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      baseURL: env.ANTHROPIC_BASE_URL || undefined,
      timeoutMs,
    }),
};
