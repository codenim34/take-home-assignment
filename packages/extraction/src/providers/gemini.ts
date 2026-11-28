import { ApiError, GoogleGenAI } from "@google/genai";
import { httpLlmError, type LlmError } from "../errors.js";
import type { ProviderDefinition } from "../registry.js";
import { StructuredExtractor, type PromptParts, type ProviderReply } from "../structured-extractor.js";

/** Gemini with structured output (responseJsonSchema). */
export class GeminiExtractor extends StructuredExtractor<GoogleGenAI> {
  protected readonly provider = "Gemini";
  protected readonly apiKeyEnv = "GEMINI_API_KEY";
  private readonly timeoutMs: number;

  constructor(model: string, opts: { apiKey?: string; timeoutMs?: number; baseUrl?: string } = {}) {
    super(
      model,
      opts.apiKey
        ? new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: opts.baseUrl ? { baseUrl: opts.baseUrl } : undefined })
        : null,
    );
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  protected describeRequest(p: PromptParts) {
    return { model: this.model, system: p.system, user: p.user, responseJsonSchema: p.jsonSchema };
  }

  protected async send(client: GoogleGenAI, p: PromptParts, signal?: AbortSignal): Promise<ProviderReply> {
    const response = await client.models.generateContent({
      model: this.model,
      contents: p.user,
      config: {
        systemInstruction: p.system,
        responseMimeType: "application/json",
        responseJsonSchema: p.jsonSchema,
        maxOutputTokens: 4096,
        abortSignal: signal,
        httpOptions: { timeout: this.timeoutMs },
      },
    });
    const candidate = response.candidates?.[0];
    const raw = {
      modelVersion: response.modelVersion,
      finishReason: candidate?.finishReason,
      promptFeedback: response.promptFeedback,
      text: response.text,
      usage: response.usageMetadata,
    };
    let problem: string | undefined;
    if (!candidate || response.promptFeedback?.blockReason) {
      problem = `The model declined to process this document (${response.promptFeedback?.blockReason ?? "no candidate"})`;
    } else if (candidate.finishReason === "MAX_TOKENS") {
      problem = "The model's answer was cut off (MAX_TOKENS)";
    } else if (candidate.finishReason && candidate.finishReason !== "STOP") {
      problem = `The model stopped early (${candidate.finishReason})`;
    }
    return { model: response.modelVersion ?? this.model, raw, problem, output: response.text ?? "" };
  }

  protected toLlmError(err: unknown, prompt: unknown): LlmError {
    if (!(err instanceof ApiError)) return super.toLlmError(err, prompt);
    // Gemini puts the suggested wait in the body: "retryDelay": "31s".
    const delay = /retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(err.message)?.[1];
    return httpLlmError(this.provider, err.status, err.message, prompt, {
      afterMs: delay ? Number(delay) * 1000 : undefined,
    });
  }
}

export const gemini: ProviderDefinition = {
  name: "gemini",
  defaultModel: "gemini-3.8-flash",
  create: ({ model, timeoutMs, env }) =>
    new GeminiExtractor(model, {
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined,
      baseUrl: env.GEMINI_BASE_URL || undefined,
      timeoutMs,
    }),
};
