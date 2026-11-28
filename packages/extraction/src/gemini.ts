import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { CandidateValue } from "@lomi/core";
import { LlmError, buildPrompt, buildSchema, type ExtractRequest, type ExtractResult, type Extractor } from "./llm.js";

/**
 * Gemini with structured output (responseJsonSchema). Same prompt, same
 * schema and same downstream validation as the Anthropic extractor: the
 * provider only produces candidates; the evidence check decides what is kept.
 */
export class GeminiExtractor implements Extractor {
  private client: GoogleGenAI | null;
  private timeoutMs: number;

  constructor(
    public readonly model: string,
    opts: { apiKey?: string; timeoutMs?: number; baseUrl?: string } = {},
  ) {
    this.client = opts.apiKey ? new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined }) : null;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const { system, user } = buildPrompt(req);
    const schema = buildSchema(req.fields);
    // Gemini accepts a JSON Schema subset; the "$schema" meta key isn't part of it.
    const { $schema: _meta, ...jsonSchema } = z.toJSONSchema(schema);
    const prompt = { model: this.model, system, user, responseJsonSchema: jsonSchema };
    if (!this.client) {
      throw new LlmError("GEMINI_API_KEY is not set. Add it to .env (or set LLM_PROVIDER=fake) and retry.", prompt);
    }

    let response;
    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          maxOutputTokens: 4096,
          abortSignal: req.signal,
          httpOptions: { timeout: this.timeoutMs },
        },
      });
    } catch (err) {
      if (req.signal?.aborted) throw req.signal.reason;
      if (err instanceof ApiError) {
        throw new LlmError(`LLM request failed (${err.status}): ${err.message}`, prompt);
      }
      throw new LlmError(`LLM request failed: ${(err as Error).message}`, prompt);
    }

    const candidate = response.candidates?.[0];
    const raw = {
      modelVersion: response.modelVersion,
      finishReason: candidate?.finishReason,
      promptFeedback: response.promptFeedback,
      text: response.text,
      usage: response.usageMetadata,
    };
    if (!candidate || response.promptFeedback?.blockReason) {
      throw new LlmError(`The model declined to process this document (${response.promptFeedback?.blockReason ?? "no candidate"})`, prompt, raw);
    }
    if (candidate.finishReason === "MAX_TOKENS") {
      throw new LlmError("The model's answer was cut off (MAX_TOKENS)", prompt, raw);
    }
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      throw new LlmError(`The model stopped early (${candidate.finishReason})`, prompt, raw);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      throw new LlmError("The model returned output that is not valid JSON", prompt, raw);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new LlmError(`The model returned output that did not match the schema: ${result.error.message}`, prompt, raw);
    }
    return {
      model: response.modelVersion ?? this.model,
      candidates: result.data as Record<string, CandidateValue>,
      prompt,
      rawResponse: raw,
    };
  }
}
