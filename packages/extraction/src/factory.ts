import { AnthropicExtractor, type Extractor } from "./llm.js";
import { FakeExtractor } from "./fake.js";

export function createExtractor(env: NodeJS.ProcessEnv = process.env): Extractor {
  const provider = env.LLM_PROVIDER ?? "anthropic";
  if (provider === "fake") return new FakeExtractor();
  if (provider !== "anthropic") throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  return new AnthropicExtractor(env.LLM_MODEL || "claude-sonnet-5-5", {
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
  });
}
