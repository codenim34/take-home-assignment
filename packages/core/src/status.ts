/** Lifecycle of one document version. Lives in Postgres; Redis never owns it. */
export const VERSION_STATUSES = ["queued", "extracting", "extracted", "failed", "superseded"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** Review state of one extracted value. */
export const REVIEW_STATES = ["pending", "approved", "corrected", "carried_over"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface ProgressCounts {
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carried_over: number;
  gaps: number;
}

export function emptyProgress(): ProgressCounts {
  return { total: 0, pending: 0, approved: 0, corrected: 0, carried_over: 0, gaps: 0 };
}
