import { AnthropicExtractor, type Extractor } from "./llm.js";
import { FakeExtractor } from "./fake.js";

export function createExtractor(env: NodeJS.ProcessEnv = process.env): Extractor {
  const provider = env.LLM_PROVIDER ?? "anthropic";
  if (provider === "fake") return new FakeExtractor(Number(env.FAKE_LLM_DELAY_MS ?? 1500));
  if (provider !== "anthropic") throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  return new AnthropicExtractor(env.LLM_MODEL || "claude-sonnet-5-5", {
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
  });
}
