import Groq from "groq-sdk";
import { z } from "zod";
import type { CandidateValue } from "@lomi/core";
import { LlmError, buildPrompt, buildSchema, httpLlmError, type ExtractRequest, type ExtractResult, type Extractor } from "./llm.js";

/**
 * Groq (OpenAI-compatible chat API) with strict JSON-schema structured output.
 * Same prompt, schema and downstream evidence validation as the other providers.
 */
export class GroqExtractor implements Extractor {
  private client: Groq | null;

  constructor(
    public readonly model: string,
    opts: { apiKey?: string; timeoutMs?: number; baseURL?: string } = {},
  ) {
    // maxRetries: 0 — rate limits are handled by our own durable retry (re-queue with delay).
    this.client = opts.apiKey
      ? new Groq({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 })
      : null;
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const { system, user } = buildPrompt(req);
    const schema = buildSchema(req.fields);
    const { $schema: _meta, ...jsonSchema } = z.toJSONSchema(schema);
    const prompt = { model: this.model, system, user, schema: jsonSchema };
    if (!this.client) {
      throw new LlmError("GROQ_API_KEY is not set. Add it to .env (or set LLM_PROVIDER=fake) and retry.", prompt);
    }

    let response;
    try {
      response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "extraction", schema: jsonSchema, strict: true },
          },
          temperature: 0,
          max_completion_tokens: 4096,
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (req.signal?.aborted) throw req.signal.reason;
      if (err instanceof Groq.APIError) throw httpLlmError("Groq", err.status, err.message, prompt, err.headers);
      throw httpLlmError("Groq", undefined, (err as Error).message, prompt);
    }

    const choice = response.choices[0];
    const raw = { id: response.id, model: response.model, finish_reason: choice?.finish_reason, content: choice?.message.content, usage: response.usage };
    if (!choice) throw new LlmError("The model returned no answer", prompt, raw);
    if (choice.finish_reason === "length") throw new LlmError("The model's answer was cut off (length)", prompt, raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message.content ?? "");
    } catch {
      throw new LlmError("The model returned output that is not valid JSON", prompt, raw);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new LlmError(`The model returned output that did not match the schema: ${result.error.message}`, prompt, raw);
    }
    return { model: response.model, candidates: result.data as Record<string, CandidateValue>, prompt, rawResponse: raw };
  }
}
