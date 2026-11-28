/**
 * Ports: the interfaces the application depends on (Dependency Inversion).
 * The worker and API are written against these; Postgres, BullMQ and the LLM
 * SDKs are adapters that implement them in their own packages. Each port is
 * small and role-specific (Interface Segregation): the reconciler doesn't see
 * the commit API, the API doesn't see the LLM.
 */
import type { CandidateValue, ValidatedValue } from "./evidence.js";
import type { DocumentType, FieldDef } from "./fields.js";

// ---------------------------------------------------------------- LLM ------

export interface ExtractRequest {
  documentType: DocumentType;
  fields: readonly FieldDef[];
  text: string;
  signal?: AbortSignal;
}

export interface ExtractResult {
  model: string;
  candidates: Record<string, CandidateValue>;
  /** What was sent, stored per run for debugging. */
  prompt: unknown;
  /** What came back, stored per run for debugging. */
  rawResponse: unknown;
}

/** Text in, candidate values out. One implementation per LLM provider (Strategy). */
export interface Extractor {
  readonly model: string;
  extract(req: ExtractRequest): Promise<ExtractResult>;
}

// -------------------------------------------------------------- Queue ------

/** "Version X needs work." Delivery is best-effort; Postgres stays the source of truth. */
export interface JobQueue {
  enqueue(versionId: string, attempts: number): Promise<void>;
}

// ---------------------------------------------------- Extraction state ------

export interface VersionToExtract {
  versionId: string;
  documentType: DocumentType;
  pdf: Uint8Array;
  /** 1-based attempt number of this claim. */
  attempt: number;
}

export interface ClaimOptions {
  leaseMs: number;
  maxAttempts: number;
  model: string;
  workerId?: string;
}

export interface RunRef {
  versionId: string;
  /** Fencing token: only the holder may change the version's state. */
  runId: string;
}

export type CommitResult =
  | { committed: true; values: number; carried: number }
  | { committed: false; reason: "superseded" | "lost ownership" };

/** Every state transition a worker performs on a version. Each one is atomic and guarded by the run id. */
export interface ExtractionStore {
  claim(versionId: string, opts: ClaimOptions): Promise<(RunRef & { version: VersionToExtract }) | null>;
  renewLease(run: RunRef, leaseMs: number): Promise<boolean>;
  recordRunIO(runId: string, io: { model?: string; prompt?: unknown; rawResponse?: unknown }): Promise<void>;
  commit(run: RunRef, result: { parsedText: string; values: ValidatedValue[] }): Promise<CommitResult>;
  markFailed(run: RunRef, error: string, parsedText?: string): Promise<boolean>;
  /** Back to queued after `delayMs`, spending the attempt (or failed when none are left). */
  scheduleRetry(run: RunRef, error: string, delayMs: number, maxAttempts: number): Promise<boolean>;
  /** Back to queued immediately, attempt refunded (graceful shutdown). */
  releaseForShutdown(run: RunRef): Promise<boolean>;
}

/** What the reconciler needs: find work that Redis may have lost. */
export interface RecoveryStore {
  expireOrphanedLeases(workerId: string): Promise<string[]>;
  reconcile(maxAttempts: number): Promise<{ requeued: string[]; failed: string[]; queued: { id: string; attempts: number }[] }>;
}
