import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const versionStatus = pgEnum("version_status", ["queued", "extracting", "extracted", "failed", "superseded"]);
export const runStatus = pgEnum("run_status", ["running", "succeeded", "failed", "abandoned", "superseded"]);
export const reviewState = pgEnum("review_state", ["pending", "approved", "corrected", "carried_over"]);
export const changeKind = pgEnum("change_kind", ["new", "unchanged", "changed"]);
export const reviewAction = pgEnum("review_action", ["approve", "correct"]);

/** A logical document (e.g. "the Meridian invoice"). Versions hang off it. */
export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  /** Latest uploaded version. Only values of this version can be reviewed. */
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One uploaded PDF. Status is the source of truth for extraction progress.
 * The PDF bytes and the parsed text live here so version N can always be
 * re-validated and displayed against its own text, forever.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    version: integer("version").notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    pdf: bytea("pdf").notNull(),
    parsedText: text("parsed_text"),
    status: versionStatus("status").notNull().default("queued"),
    /** Number of times a worker has claimed this version. */
    attempts: integer("attempts").notNull().default(0),
    /** Fencing token: only the run that holds it may commit or fail the version. */
    currentRunId: uuid("current_run_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    error: text("error"),
    /** Version whose values this one was compared against (carry-over base). */
    baseVersionId: uuid("base_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("document_versions_doc_version_uq").on(t.documentId, t.version),
    index("document_versions_status_idx").on(t.status),
  ],
);

/** Every extraction attempt, kept for debugging: prompt, raw LLM response, outcome. */
export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id),
    attempt: integer("attempt").notNull(),
    status: runStatus("status").notNull().default("running"),
    model: text("model"),
    /** Which worker process held the run (stable per container), for fast orphan recovery on restart. */
    workerId: text("worker_id"),
    prompt: jsonb("prompt"),
    rawResponse: jsonb("raw_response"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("extraction_runs_version_idx").on(t.versionId)],
);

/**
 * One value per (version, field). The unique index is what makes extraction
 * idempotent: however many times a version is processed, it can never hold
 * two values for the same field.
 *
 * The LLM's value is never overwritten. Corrections live in `reviews`.
 */
export const extractedValues = pgTable(
  "extracted_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => extractionRuns.id),
    field: text("field").notNull(),
    fieldType: text("field_type").notNull(),
    value: text("value"),
    rawValue: text("raw_value"),
    evidence: text("evidence"),
    evidenceStart: integer("evidence_start"),
    evidenceEnd: integer("evidence_end"),
    evidenceMatch: text("evidence_match"),
    gapReason: text("gap_reason"),
    reviewState: reviewState("review_state").notNull().default("pending"),
    change: changeKind("change").notNull().default("new"),
    changeDetail: text("change_detail"),
    previousValueId: uuid("previous_value_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("extracted_values_version_field_uq").on(t.versionId, t.field)],
);

/**
 * Append-only review log. The latest row per value is its current decision.
 * A carried-over review is a copy pointing at the review it came from, so the
 * new version's value "keeps its review" without mutating history.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valueId: uuid("value_id")
      .notNull()
      .references(() => extractedValues.id),
    action: reviewAction("action").notNull(),
    correctedValue: text("corrected_value"),
    note: text("note"),
    reviewer: text("reviewer").notNull().default("reviewer"),
    carriedFromReviewId: uuid("carried_from_review_id"),
    isCarried: boolean("is_carried").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reviews_value_idx").on(t.valueId, t.createdAt)],
);

export const nowSql = sql`now()`;
