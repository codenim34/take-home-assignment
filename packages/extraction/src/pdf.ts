import { extractText, getDocumentProxy } from "unpdf";

export class PdfParseError extends Error {}

/**
 * PDF bytes -> plain text. This exact string is stored per version and is the
 * ONLY text evidence is validated against and the UI highlights in.
 */
export async function parsePdf(bytes: Uint8Array): Promise<string> {
  let text: string;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    text = (await extractText(pdf, { mergePages: true })).text;
  } catch (err) {
    throw new PdfParseError(`Could not parse PDF: ${(err as Error).message}`);
  }
  if (!text.trim()) throw new PdfParseError("PDF contains no extractable text (scanned image?)");
  return text;
}
