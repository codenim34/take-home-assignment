import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pino from "pino";
import type { CandidateValue, ExtractRequest, JobQueue } from "@lomi/core";
import { PgExtractionStore, createDb, runMigrations, type Db } from "@lomi/db";
import { ScriptedExtractor } from "@lomi/extraction/testing";
import type { Deps } from "@lomi/worker";
import { buildApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/lomi_test";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/documents");
export const pdf = (name: string) => readFileSync(path.join(fixtures, name));

export async function setupDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  await runMigrations(DATABASE_URL);
  return createDb(DATABASE_URL);
}

export async function resetDb(db: Db) {
  await db.execute(sql`truncate reviews, extracted_values, extraction_runs, document_versions, documents cascade`);
}

export class RecordingQueue implements JobQueue {
  jobs: { versionId: string; attempts: number }[] = [];
  fail = false;
  async enqueue(versionId: string, attempts: number) {
    if (this.fail) throw new Error("redis is down");
    this.jobs.push({ versionId, attempts });
  }
}

export async function makeApp(db: Db, queue: JobQueue = new RecordingQueue()) {
  return buildApp({ db, queue, logger: false });
}

export const store = (db: Db) => new PgExtractionStore(db);

export const log = pino({ level: "silent" });

export function deps(db: Db, extractor: Deps["extractor"], extra: Partial<Deps> = {}): Deps {
  return {
    store: store(db),
    extractor,
    log,
    config: { leaseMs: 30_000, heartbeatMs: 50, maxAttempts: 3, retryBaseMs: 1000 },
    ...extra,
  };
}

/** What a well-behaved LLM returns for the invoice fixtures (read from the text, like the model would). */
export function invoiceAnswer(req: ExtractRequest): Record<string, CandidateValue> {
  const line = (label: string) => req.text.split("\n").find((l) => l.startsWith(label))!.trim();
  const after = (l: string) => l.slice(l.indexOf(":") + 1).trim();
  const total = line("Total Due:");
  return {
    invoice_number: { value: after(line("Invoice Number:")), evidence: line("Invoice Number:"), reason: null },
    issue_date: { value: after(line("Issue Date:")), evidence: line("Issue Date:"), reason: null },
    due_date: { value: after(line("Due Date:")), evidence: line("Due Date:"), reason: null },
    vendor_name: { value: "Meridian Office Supplies LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
    total_amount: { value: after(total).replace(/[$,]/g, ""), evidence: total, reason: null },
  };
}

export const goodExtractor = () => new ScriptedExtractor((req) => invoiceAnswer(req));

/** An extractor that blocks until released, to hold a run "mid-extraction". */
export function gatedExtractor() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const extractor = new ScriptedExtractor(async (req) => {
    started();
    await Promise.race([
      gate,
      new Promise((_, rej) => req.signal?.addEventListener("abort", () => rej(req.signal!.reason), { once: true })),
    ]);
    return invoiceAnswer(req);
  });
  return { extractor, release, started: startedP };
}

export async function upload(app: Awaited<ReturnType<typeof makeApp>>, url: string, file: Buffer, fields: Record<string, string> = {}) {
  const boundary = "----lomitest";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return app.inject({
    method: "POST",
    url,
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
}
