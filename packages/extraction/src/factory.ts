import { AnthropicExtractor, type Extractor } from "./llm.js";
import { FakeExtractor } from "./fake.js";
import { GeminiExtractor } from "./gemini.js";

/** LLM_PROVIDER = gemini (default) | anthropic | fake. */
export function createExtractor(env: NodeJS.ProcessEnv = process.env): Extractor {
  const provider = env.LLM_PROVIDER || "gemini";
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? 60_000);
  switch (provider) {
    case "fake":
      return new FakeExtractor(Number(env.FAKE_LLM_DELAY_MS ?? 1500));
    case "gemini":
      return new GeminiExtractor(env.LLM_MODEL || "gemini-3.8-flash", {
        apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined,
        baseUrl: env.GEMINI_BASE_URL || undefined,
        timeoutMs,
      });
    case "anthropic":
      return new AnthropicExtractor(env.LLM_MODEL || "claude-sonnet-5-5", {
        apiKey: env.ANTHROPIC_API_KEY || undefined,
        baseURL: env.ANTHROPIC_BASE_URL || undefined,
        timeoutMs,
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" (use gemini, anthropic or fake)`);
  }
}
