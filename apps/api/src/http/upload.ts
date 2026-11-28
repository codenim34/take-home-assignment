import type { FastifyRequest } from "fastify";
import { DomainError, type NewFile } from "@lomi/db";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Reads a multipart upload: exactly one PDF part plus any text fields. */
export async function readUpload(req: FastifyRequest): Promise<{ fields: Record<string, string>; file: NewFile }> {
  const fields: Record<string, string> = {};
  let file: NewFile | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      file = { fileName: part.filename || "upload.pdf", pdf: await part.toBuffer() };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) throw new DomainError("invalid", 'Missing "file" part');
  if (file.pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DomainError("invalid", "File is not a PDF");
  return { fields, file };
}
