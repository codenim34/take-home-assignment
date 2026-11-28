import type { CandidateValue, ExtractRequest, ExtractResult, Extractor } from "@lomi/core";
import { buildPrompt } from "./prompt.js";

/** Test double (import from "@lomi/extraction/testing"): returns whatever the test script says, optionally slowly. */
export class ScriptedExtractor implements Extractor {
  readonly model = "scripted";
  calls = 0;
  constructor(
    private readonly script: (
      req: ExtractRequest,
      call: number,
    ) => Promise<Record<string, CandidateValue>> | Record<string, CandidateValue>,
  ) {}

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    const call = ++this.calls;
    const candidates = await this.script(req, call);
    return { model: this.model, candidates, prompt: buildPrompt(req), rawResponse: { candidates } };
  }
}
