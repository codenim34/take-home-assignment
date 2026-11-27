CREATE TYPE "public"."change_kind" AS ENUM('new', 'unchanged', 'changed');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('approve', 'correct');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'approved', 'corrected', 'carried_over');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed', 'abandoned', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('queued', 'extracting', 'extracted', 'failed', 'superseded');--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"pdf" "bytea" NOT NULL,
	"parsed_text" text,
	"status" "version_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"current_run_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"base_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field" text NOT NULL,
	"field_type" text NOT NULL,
	"value" text,
	"raw_value" text,
	"evidence" text,
	"evidence_start" integer,
	"evidence_end" integer,
	"evidence_match" text,
	"gap_reason" text,
	"review_state" "review_state" DEFAULT 'pending' NOT NULL,
	"change" "change_kind" DEFAULT 'new' NOT NULL,
	"change_detail" text,
	"previous_value_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"model" text,
	"prompt" jsonb,
	"raw_response" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_id" uuid NOT NULL,
	"action" "review_action" NOT NULL,
	"corrected_value" text,
	"note" text,
	"reviewer" text DEFAULT 'reviewer' NOT NULL,
	"carried_from_review_id" uuid,
	"is_carried" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_extraction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_extracted_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."extracted_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_version_uq" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "document_versions_status_idx" ON "document_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "extracted_values_version_field_uq" ON "extracted_values" USING btree ("version_id","field");--> statement-breakpoint
CREATE INDEX "extraction_runs_version_idx" ON "extraction_runs" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "reviews_value_idx" ON "reviews" USING btree ("value_id","created_at");