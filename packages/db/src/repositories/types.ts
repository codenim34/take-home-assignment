import type { documentVersions, documents, extractedValues, reviews } from "../schema.js";

export type VersionRow = typeof documentVersions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ValueRow = typeof extractedValues.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;

export interface NewFile {
  fileName: string;
  pdf: Buffer;
}
