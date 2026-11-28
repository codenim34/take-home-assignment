# Document review: PDF → LLM extraction → human review

PDFs go in, an LLM extracts typed values with a verbatim quote for each one, and a reviewer approves or corrects every value. When a revised PDF arrives, reviews whose evidence didn't change are carried over and only the changed values go back to the reviewer.

The brief is in [docs/ASSIGNMENT.md](docs/ASSIGNMENT.md).

## Run it

```sh
cp .env.example .env        # put your GEMINI_API_KEY in it
docker compose up --build
```

- UI: http://localhost:8080, API: http://localhost:3000
- `migrate` runs the migrations, seeds version 1 of the three fixture documents, and exits. The worker picks the seeded documents up on its own.
- No key? Run `LLM_PROVIDER=fake docker compose up`. The fake is a "Label: value" line matcher for clicking around, not real extraction. Without a key and without `fake`, every extraction fails visibly with "GEMINI_API_KEY is not set" and can be retried once a key is set.
- Provider: `LLM_PROVIDER=gemini` (default, `gemini-3.8-flash`) or `anthropic` (`claude-sonnet-5-5`, needs `ANTHROPIC_API_KEY`). Override the model with `LLM_MODEL`.

**What to click first**
1. Open the **Invoice**. Each value sits next to its quote, and the quote is highlighted in the document text on the right. Approve all five (correct one if you like).
2. Click **Upload new version** and pick `fixtures/documents/invoice-001.v2.pdf`. The status changes to extracting and the page polls.
3. **Needs your review** now holds exactly `due_date` and `total_amount`. Each shows the v1 value and v1 review beside it. The other three are **carried over** with their reviews intact. Use the version picker to open v1, which is read-only but intact.

**Failure drills** (what the brief says you will try): `scripts/chaos.sh [restart|kill|flush|supersede]`. Run the stack with `LLM_PROVIDER=fake FAKE_LLM_DELAY_MS=8000` to get a wide mid-extraction window.

```sh
docker compose exec redis redis-cli FLUSHALL && docker compose restart   # nothing is lost
```

## Layout

```
apps/
  api/        Fastify HTTP API + seed script. Never calls the LLM.
  worker/     BullMQ consumer + reconciler. The only process that calls the LLM.
  web/        Vite + React + TanStack Query review UI (served by nginx in compose).
packages/
  core/       Pure domain logic, no I/O: field defs, normalisation, evidence
              validation, carry-over rule. Most of the bug-prone code lives here.
  db/         Drizzle schema, migrations, and every SQL state transition
              (claim, heartbeat, guarded commit, fail, reconcile, review, reads).
  extraction/ PDF → text (unpdf), text → candidates (Gemini or Anthropic, structured output),
              plus a fake and a scripted extractor for tests.
  queue/      Queue name, job-id convention, enqueue helper. Small on purpose.
```

Why it's split this way:
- **Pure logic is separate from I/O.** `core` has no dependencies and is unit-tested against the real fixture text. The hallucination check and the carry-over rule are where a subtle bug costs the most, so they are the easiest code to test.
- **State transitions live in one place.** Every status change is a single conditional SQL statement in `db/repo.ts`. The API and worker call those functions and never write status themselves, which makes the whole state machine reviewable in one file.
- **API and worker are separate processes.** A slow or crashing LLM call can't stall uploads, and the worker scales on its own.
- **The web app imports types only from `db`.** Its response types are `Awaited<ReturnType<typeof getDocument>>` passed through a `Jsonify` helper, so a server change that breaks the UI fails `tsc`, and no server code ends up in the bundle.

`turbo.json` wires `build` (dependency-ordered and cached), `lint`, `typecheck`, `test` (unit, cached) and `test:integration` (real Postgres + Redis, never cached). CI (`.github/workflows/ci.yml`) runs all of them and also builds the Docker images.

```sh
pnpm install
pnpm turbo run lint typecheck build test                   # no services needed
DATABASE_URL=postgres://… REDIS_URL=redis://… pnpm turbo run test:integration
```

## Schema

```
documents          id, type, title, current_version_id
document_versions  document_id, version (unique per doc), pdf bytea, file_sha256,
                   parsed_text, status, attempts, current_run_id, lease_expires_at,
                   error, base_version_id
extraction_runs    one per attempt: worker_id, model, prompt, raw_response, status, error
extracted_values   one per (version, field), UNIQUE(version_id, field):
                   value, raw_value, evidence + offsets, gap_reason,
                   review_state, change, previous_value_id
reviews            append-only: approve | correct (corrected_value, note),
                   is_carried, carried_from_review_id
```

- **Versions are immutable snapshots.** Each one stores its own PDF bytes and its own parsed text, so evidence validation and highlighting for version N always use N's text, even after N+1 exists. Nothing is ever deleted.
- **`UNIQUE(version_id, field)` is the idempotency backstop.** However a second run happens, a version can't hold two values for one field.
- **Corrections are annotations, not overwrites.** `extracted_values.value` is always what the LLM said, after validation. A correction is a `reviews` row, and the UI shows the effective value with "LLM said X" struck through. That keeps an audit trail, lets you measure LLM accuracy per field, and keeps carry-over comparing the LLM's own evidence.
- **Carried-over reviews are copied, not shared.** The new version's value gets its own review row with `is_carried = true` and a pointer to the original. Each version's reviews can be queried on their own, and v1's history is never touched.
- **`previous_value_id`** links a value to the same field in the version it was compared against, which is how the UI shows "v1: 2025-10-14 (approved)" beside a changed value.

## How extraction is coordinated (Redis vs Postgres)

**Postgres decides; Redis only wakes workers.** Redis holds nothing that can't be rebuilt, and it runs without persistence in compose on purpose.

| Lives in Postgres (must survive) | Lives in Redis (disposable) |
|---|---|
| version status, attempts, lease, run id | "version X needs work" job messages |
| PDFs, parsed text, values, reviews | BullMQ bookkeeping |
| every run's prompt, raw response, error | |

Lifecycle: `queued → extracting → extracted | failed`, plus `superseded`.

1. **Upload:** the PDF and a `queued` version are written in one transaction, then the API enqueues and returns `202`. If Redis is down the upload still succeeds, because the version is `queued` in Postgres and gets picked up later (step 5).
2. **Claim:** `UPDATE … SET status='extracting', attempts=attempts+1, current_run_id=<new uuid>, lease=now()+30s WHERE status='queued' AND attempts < max`. Duplicate jobs race here and exactly one wins. The run id acts as a **fencing token**.
3. **Work:** parse the PDF, call the LLM (60s timeout), and heartbeat the lease every 10s. If a heartbeat finds the run no longer owns the version (superseded or reclaimed), the LLM call is aborted.
4. **Guarded commit:** one transaction re-checks `status='extracting' AND current_run_id=<mine>`, compares against the previous extracted version, inserts all values plus carried reviews, and flips the version to `extracted`. It's all or nothing. A late worker whose lease expired, or whose version was superseded, cannot write anything.
5. **Reconciler:** runs in the worker at startup and every 10s. Expired leases go back to `queued`, or to `failed` after 3 attempts so a poison PDF can't loop forever. **Every** `queued` version is re-enqueued, and BullMQ dedupes by `jobId = <versionId>-a<attempts>`. Putting the attempt number in the id means a re-queue after a crash is a new job that a stale job can't swallow.

How each failure plays out:
- **`docker compose restart` (SIGTERM):** the worker aborts in-flight runs and hands them back as `queued` without spending an attempt. If Postgres is stopping at the same moment and that write fails, the next item takes over.
- **Killed worker (SIGKILL):** runs record `worker_id` (the container hostname, stable across restarts). On startup a worker expires the leases of runs still marked as its own, since they're certainly dead, and recovers them immediately. A worker that never comes back is recovered when its lease expires (≤ 30s + one sweep).
- **`FLUSHALL` + restart:** the queue is empty, and the startup sweep re-enqueues every `queued` version from Postgres. Values, reviews and run logs were never in Redis.
- **Postgres down:** the API returns errors, the worker's sweeps log and retry, and nothing is half-written because every transition is one transaction.
- **LLM / parse error:** the version becomes `failed` with the message, the run keeps its prompt and raw response, and **Retry** (`POST /documents/:id/retry`) resets the attempt budget.
- **Same version extracted twice** (retry, recovery, double click, duplicate job): the conditional claim plus the guarded commit plus `UNIQUE(version_id, field)` mean one set of values. Re-uploading byte-identical bytes returns the current version (`200 duplicate: true`) instead of creating a new one.

All of these are covered in `apps/api/test/integration.test.ts`, against real Postgres and Redis with a scripted LLM, and were exercised on the real stack with `scripts/chaos.sh`.

## Extraction and the hallucination defence

The LLM (Gemini by default via `responseJsonSchema`, or Claude via structured outputs; both behind one `Extractor` interface) returns `{value, evidence, reason}` for every field of the type. The prompt asks for evidence copied character for character, *including the label* ("Due Date: 2025-10-14"). That matters because `2025-09-14` appears twice in the revised invoice. Each candidate then goes through `core/validateCandidate`:

1. If there's no value, it's a gap with the model's reason. The model is told never to guess.
2. The value must parse as its type (date, money, number, percent, string), or it becomes a gap.
3. **The quote must appear verbatim in this version's parsed text.** The match is exact first, then whitespace-insensitive only, because a quote that spans a PDF line break often comes back with a space. Any other difference makes it a gap, and the rejected quote is recorded in the reason.
4. **The value must actually be stated in the quote.** This catches a real quote paired with an invented value, such as quoting the subtotal line and returning a different total.

Gaps are stored as `value: null` with a reason and shown in the UI, never hidden. A reviewer can confirm a gap ("not in document") or enter the value as a correction.

## What "unchanged" means (carry-over)

A field carries its review over only if **both** of these hold:
- its **normalised value is equal** (dates as ISO, money as `1234.50`, strings compared case-insensitively), **and**
- its **evidence is the same passage**: the quotes are identical apart from whitespace, or the previous quote still appears verbatim in the new text. The second case covers the LLM picking a slightly different quote for the same passage.

Offsets are ignored on purpose, so text moving around (a paragraph inserted above, a reflowed table) doesn't matter. Gaps never carry over, because there's no evidence to compare. A value whose previous version was never reviewed is marked unchanged but stays pending, since there's no review to carry.

The rule leans toward re-review. A false "changed" costs the reviewer five seconds, while a false "unchanged" silently trusts a value nobody checked. On the fixtures, v2 sends exactly `due_date` and `total_amount` back to pending. That is asserted in both the unit tests and the integration tests.

The comparison runs **inside the guarded commit transaction**, so it sees the previous version's reviews as they stand at commit time. Reviews are only accepted on the current version (`409` otherwise), and the review transaction takes the same document row lock as uploads. So once v2 exists, nobody can review v1 and have that review missed.

## Decisions the brief left open

| Question | Choice | Why |
|---|---|---|
| Correction: replace or annotate? | **Annotate** (append-only `reviews`) | Audit trail, LLM accuracy metrics, carry-over keeps comparing the LLM's own evidence. |
| New version while the previous one is still extracting | **Supersede** | The client sent something newer. Finishing the stale one wastes an LLM call and reviewer time, rejecting pushes retry logic onto the client, and queueing means extracting a document nobody will review. The superseded version stays queryable, and its worker's late result is discarded by the guarded commit. The new version compares against the latest **extracted** version. |
| Which version can be reviewed | Only the current one | Keeps carry-over correct (see above). Older versions are read-only history. |
| Polling vs streaming | **Polling every 2s, only while something is queued or extracting** | Status changes about three times per document and extraction takes seconds. SSE or WebSockets would add connection state, proxy configuration and reconnect logic for no visible gain, while polling survives restarts for free. TanStack Query also refetches on window focus. |
| Store parsed text or re-parse | **Store per version** | Evidence and highlighting must be stable forever. Re-parsing with a future parser version could shift the text under existing offsets. |
| Where PDFs live | `bytea` in Postgres | One system of record and nothing extra to run. Fine for one-page documents (see scale notes). |
| Retries | Owned by Postgres (`attempts`), BullMQ `attempts: 1` | One retry system with one source of truth. Two would disagree after a flush. |
| Duplicate upload of identical bytes | Returns the current version | An impatient double upload shouldn't create v3. |

## What I cut, and what I'd do next

- **Auth and reviewer identity.** `reviewer` is a free-text field that defaults to "reviewer". Next would be real users and showing who approved what.
- **Automatic retry of transient LLM errors** (429/529) with backoff. Today one SDK retry happens, then the version is `failed` and needs a click. Next: classify errors and re-queue retryable ones with a delay, within the attempt budget.
- **Large and scanned documents.** No OCR and no chunking. A scanned PDF fails with "no extractable text".
- **PDF view with highlights.** The UI highlights the quote in the parsed text and links to the PDF, but doesn't highlight inside the PDF itself.
- **UI tests.** The behaviour lives in the API and is covered there. Next would be a Playwright run of the v1 → v2 review flow.
- **A shared, validated API contract** (zod schemas used by both the server and the client) instead of type-only inference.

## At 10,000 documents

- **Move PDFs to object storage** (S3) with the key and hash in Postgres. `bytea` bloats the table and backups.
- **The reconciler sweep:** add a partial index on `status in ('queued','extracting')` and enqueue in pages. Better still, replace "enqueue on upload + sweep" with a transactional outbox table that's drained in order, so the sweep only handles leases.
- **List endpoint:** paginate it, and keep progress counters on the version row (updated in the review transaction) instead of `GROUP BY` on every request.
- **Throughput:** run more workers. Claiming is already safe for N workers. Add BullMQ rate limiting that matches the provider's limits, and use the Message Batches API (about 50% cheaper) for bulk re-extraction.
- **Quality loop:** track correction and gap rates per field and per document type. That's the signal for prompt changes, and it's why corrections are stored next to the original value.
- **Real-time UI:** with many reviewers on a shared queue, push status over SSE and add review assignment and locking so two people don't review the same value.
