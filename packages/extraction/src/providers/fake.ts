import type { CandidateValue, ExtractRequest, ExtractResult, Extractor } from "@lomi/core";
import { buildPrompt } from "../prompt.js";
import type { ProviderDefinition } from "../registry.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Offline stand-in for the LLM (LLM_PROVIDER=fake). NOT the real extraction:
 * it only finds "Label: value" lines whose label matches the field name, so the
 * app can be clicked through without an API key. Everything else is a gap.
 */
export class FakeExtractor implements Extractor {
  readonly model = "fake-label-matcher";
  constructor(private readonly delayMs = 1500) {}

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    await sleep(this.delayMs, req.signal);
    const lines = req.text.split("\n");
    const candidates: Record<string, CandidateValue> = {};
    for (const f of req.fields) {
      const words = f.field.split("_");
      const line = lines.find((l) => {
        const [label] = l.split(":");
        return l.includes(":") && words.every((w) => label!.toLowerCase().includes(w));
      });
      candidates[f.field] = line
        ? { value: line.slice(line.indexOf(":") + 1).trim(), evidence: line.trim(), reason: null }
        : { value: null, evidence: null, reason: "Fake extractor: no 'Label: value' line for this field" };
    }
    return { model: this.model, candidates, prompt: buildPrompt(req), rawResponse: { candidates } };
  }
}

export const fake: ProviderDefinition = {
  name: "fake",
  create: ({ env }) => new FakeExtractor(Number(env.FAKE_LLM_DELAY_MS ?? 1500)),
};
