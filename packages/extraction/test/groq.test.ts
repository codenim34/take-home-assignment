import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIELDS } from "@lomi/core";
import { GroqExtractor, LlmError, createExtractor } from "../src/index.js";

let reply: () => { status: number; json: unknown; headers?: Record<string, string> } = () => ({ status: 200, json: {} });
let lastBody: Record<string, unknown> = {};
let baseURL = "";
const server = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    lastBody = JSON.parse(b);
    const r = reply();
    res.statusCode = r.status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    res.end(JSON.stringify(r.json));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  baseURL = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const req = { documentType: "invoice" as const, fields: FIELDS.invoice, text: "Total Due: $5,230.29" };
const answer = Object.fromEntries(FIELDS.invoice.map((f) => [f.field, { value: null, evidence: null, reason: "absent" }]));
const completion = (content: string, finish_reason = "stop") => ({
  status: 200,
  json: {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "openai/gpt-oss-20b",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});
const ex = () => new GroqExtractor("openai/gpt-oss-20b", { apiKey: "k", baseURL });

describe("GroqExtractor", () => {
  it("requests strict JSON-schema output and parses it", async () => {
    reply = () => completion(JSON.stringify(answer));
    const r = await ex().extract(req);
    expect(Object.keys(r.candidates)).toEqual(FIELDS.invoice.map((f) => f.field));
    expect(lastBody.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "extraction", strict: true } });
    expect(lastBody.temperature).toBe(0);
  });

  it.each([
    ["schema mismatch", () => completion('{"x":1}'), /did not match the schema/, false],
    ["truncated", () => completion("{", "length"), /cut off/, false],
    ["bad request", () => ({ status: 400, json: { error: { message: "bad" } } }), /\(400\)/, false],
    ["rate limit", () => ({ status: 429, json: { error: { message: "slow down" } }, headers: { "retry-after": "7" } }), /\(429\)/, true],
  ])("%s -> LlmError", async (_n, r, msg, retryable) => {
    reply = r;
    const err = await ex().extract(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(msg);
    expect(err.retryable).toBe(retryable);
    if (retryable) expect(err.retry.afterMs).toBe(7000);
  });

  it("is selected with LLM_PROVIDER=groq", () => {
    const e = createExtractor({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" });
    expect(e).toBeInstanceOf(GroqExtractor);
    expect(e.model).toBe("openai/gpt-oss-20b");
  });
});
