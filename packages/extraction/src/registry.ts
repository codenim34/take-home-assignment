import type { Extractor } from "@lomi/core";
import { anthropic } from "./providers/anthropic.js";
import { fake } from "./providers/fake.js";
import { gemini } from "./providers/gemini.js";
import { groq } from "./providers/groq.js";

/** How to build one LLM provider from the environment. */
export interface ProviderDefinition {
  /** Value of LLM_PROVIDER that selects it. */
  name: string;
  /** Used when LLM_MODEL is empty. */
  defaultModel?: string;
  create(opts: { model: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Extractor;
}

const DEFAULT_PROVIDER = "gemini";
const providers = new Map<string, ProviderDefinition>();

/**
 * Registry + factory. Open for extension: a new provider is one file that
 * exports a ProviderDefinition, registered here (or by the caller at startup).
 * Nothing that consumes an Extractor changes.
 */
export function registerProvider(def: ProviderDefinition): void {
  providers.set(def.name, def);
}

for (const def of [gemini, groq, anthropic, fake]) registerProvider(def);

/** LLM_PROVIDER = gemini (default) | groq | anthropic | fake, or anything registered. */
export function createExtractor(env: NodeJS.ProcessEnv = process.env): Extractor {
  const name = env.LLM_PROVIDER || DEFAULT_PROVIDER;
  const def = providers.get(name);
  if (!def) {
    throw new Error(`Unknown LLM_PROVIDER "${name}" (use ${[...providers.keys()].join(", ")})`);
  }
  return def.create({
    model: env.LLM_MODEL || def.defaultModel || def.name,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
    env,
  });
}
