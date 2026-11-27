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

/** Raised for model-side failures that should leave the version `failed`. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly prompt?: unknown,
    public readonly rawResponse?: unknown,
  ) {
    super(message);
  }
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
  private client: Anthropic;

  constructor(
    public readonly model: string,
    opts: { apiKey?: string; timeoutMs?: number } = {},
  ) {
    // Hard per-request timeout, kept well below the worker lease.
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const { system, user } = buildPrompt(req);
    const prompt = { model: this.model, system, messages: [{ role: "user", content: user }] };
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
        throw new LlmError(`LLM request failed (${err.status ?? "network"}): ${err.message}`, prompt);
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
