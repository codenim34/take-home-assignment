import { eq } from "drizzle-orm";
import { fieldType, isFieldType } from "@lomi/core";
import type { Db } from "../client.js";
import { documentVersions, extractedValues, reviews } from "../schema.js";
import { DomainError } from "./errors.js";
import { lockDocument } from "./shared.js";
import type { ReviewRow, ValueRow } from "./types.js";

/**
 * Corrections are annotations: the LLM's value is never overwritten, a review
 * row is appended and the value's review_state updated. The document row lock
 * serialises this against uploads, so a review can't land on a version that
 * just stopped being current.
 */
export async function reviewValue(
  db: Db,
  valueId: string,
  input: { action: "approve" | "correct"; value?: string | null; note?: string | null; reviewer?: string | null },
): Promise<{ value: ValueRow; review: ReviewRow }> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ value: extractedValues, version: documentVersions })
      .from(extractedValues)
      .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
      .where(eq(extractedValues.id, valueId));
    if (!found) throw new DomainError("not_found", `Value ${valueId} not found`);
    const doc = await lockDocument(tx, found.version.documentId);
    if (doc.currentVersionId !== found.version.id) {
      throw new DomainError("conflict", "This value belongs to an older version; review the current version instead");
    }
    let corrected: string | null = null;
    if (input.action === "correct") {
      if (!input.value || !input.value.trim()) throw new DomainError("invalid", "A correction needs a value");
      const type = found.value.fieldType;
      if (!isFieldType(type)) throw new DomainError("invalid", `Unknown field type "${type}"`);
      corrected = fieldType(type).normalize(input.value);
      if (corrected === null) {
        throw new DomainError("invalid", `"${input.value}" is not a valid ${found.value.fieldType}`);
      }
    }
    const [review] = await tx
      .insert(reviews)
      .values({
        valueId,
        action: input.action,
        correctedValue: corrected,
        note: input.note?.trim() || null,
        reviewer: input.reviewer?.trim() || "reviewer",
      })
      .returning();
    const [value] = await tx
      .update(extractedValues)
      .set({ reviewState: input.action === "approve" ? "approved" : "corrected" })
      .where(eq(extractedValues.id, valueId))
      .returning();
    return { value: value!, review: review! };
  });
}
