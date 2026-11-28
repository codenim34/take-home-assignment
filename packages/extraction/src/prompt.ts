import { z } from "zod";
import { fieldType, type ExtractRequest, type FieldDef } from "@lomi/core";

const SYSTEM = `You extract fields from business documents for a human review queue.
Rules:
- For each field return "value" and "evidence".
- "evidence" MUST be copied character-for-character from the document: one short contiguous passage (normally the single line) that states the value, INCLUDING its label (e.g. "Due Date: 2025-10-14", not just "2025-10-14"). Do not paraphrase, reformat, fix typos, or join separate lines. It will be checked by exact string match and discarded if it differs.
- If the document does not state a field, set value and evidence to null and explain why in "reason". Never guess or compute a value that is not written in the document.
- Format "value" as requested per field.`;

/** Same prompt for every provider. Per-field format hints come from the field type, so a new type needs no change here. */
export function buildPrompt(req: ExtractRequest) {
  const fieldList = req.fields.map((f) => `- ${f.field} (${f.type}): ${fieldType(f.type).promptHint}`).join("\n");
  const user = `Document type: ${req.documentType}

Fields to extract:
${fieldList}

<document>
${req.text}
</document>`;
  return { system: SYSTEM, user };
}

/** `{ [field]: { value, evidence, reason } }`, every key required, every leaf nullable. */
export function buildSchema(fields: readonly FieldDef[]) {
  const item = z.object({
    value: z.string().nullable(),
    evidence: z.string().nullable(),
    reason: z.string().nullable(),
  });
  return z.object(Object.fromEntries(fields.map((f) => [f.field, item])));
}

export type CandidateSchema = ReturnType<typeof buildSchema>;

/** The schema as plain JSON Schema, for providers that take one. The "$schema" meta key is not accepted by all of them. */
export function toJsonSchema(schema: CandidateSchema): Record<string, unknown> {
  const { $schema: _meta, ...json } = z.toJSONSchema(schema);
  return json;
}
