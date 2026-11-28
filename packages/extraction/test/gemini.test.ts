import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIELDS } from "@lomi/core";
import { GeminiExtractor, LlmError, createExtractor } from "../src/index.js";

// A local stand-in for the Gemini REST endpoint, so request shape and error
// handling are tested without a key or network.
let reply: (body: unknown) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
let lastBody: Record<string, unknown> = {};
let baseUrl = "";
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    lastBody = JSON.parse(b);
    const r = reply(lastBody);
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.json));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const req = { documentType: "invoice" as const, fields: FIELDS.invoice, text: "Total Due: $5,230.29" };
const answer = Object.fromEntries(
  FIELDS.invoice.map((f) => [f.field, { value: null, evidence: null, reason: "not present" }]),
);
const ok = (text: string, finishReason = "STOP") => ({
  status: 200,
  json: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }], modelVersion: "gemini-test" },
});

describe("GeminiExtractor", () => {
  const ex = () => new GeminiExtractor("gemini-test", { apiKey: "k", baseUrl });

  it("sends a JSON-schema constrained request and parses the answer", async () => {
    reply = () => ok(JSON.stringify(answer));
    const r = await ex().extract(req);
    expect(Object.keys(r.candidates)).toEqual(FIELDS.invoice.map((f) => f.field));
    const cfg = lastBody.generationConfig as Record<string, unknown>;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema).toMatchObject({ type: "object", required: FIELDS.invoice.map((f) => f.field) });
    expect(cfg.responseJsonSchema).not.toHaveProperty("$schema");
    expect(r.rawResponse).toMatchObject({ finishReason: "STOP" });
  });

  it.each([
    ["schema mismatch", () => ok('{"nope":1}'), /did not match the schema/],
    ["invalid JSON", () => ok("not json"), /not valid JSON/],
    ["truncated", () => ok("{", "MAX_TOKENS"), /cut off/],
    ["safety stop", () => ok("{}", "SAFETY"), /stopped early \(SAFETY\)/],
    ["HTTP error", () => ({ status: 400, json: { error: { code: 400, message: "API key not valid" } } }), /\(400\)/],
  ])("turns %s into an LlmError (so the version becomes failed)", async (_name, r, msg) => {
    reply = r;
    const err = await ex().extract(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(msg);
  });

  it("fails visibly when no key is configured", async () => {
    await expect(new GeminiExtractor("m").extract(req)).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("is the default provider", () => {
    expect(createExtractor({ GEMINI_API_KEY: "k" })).toBeInstanceOf(GeminiExtractor);
    expect(createExtractor({ LLM_PROVIDER: "fake" }).model).toBe("fake-label-matcher");
  });
});

describe("retryable errors", () => {
  it("marks 429 as retryable and reads Gemini's retryDelay", async () => {
    reply = () => ({
      status: 429,
      json: { error: { code: 429, message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }] } },
    });
    const err = await new GeminiExtractor("m", { apiKey: "k", baseUrl }).extract(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(true);
    expect(err.retry.afterMs).toBe(31_000);
  });

  it("does not retry a bad request", async () => {
    reply = () => ({ status: 400, json: { error: { code: 400, message: "bad" } } });
    const err = await new GeminiExtractor("m", { apiKey: "k", baseUrl }).extract(req).catch((e) => e);
    expect(err.retryable).toBe(false);
  });
});
