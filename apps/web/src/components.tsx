import type { Progress } from "./api";

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued",
  extracting: "Extracting…",
  extracted: "Extracted",
  failed: "Failed",
  superseded: "Superseded",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = status ?? "queued";
  return <span className={`badge status-${s}`}>{STATUS_TEXT[s] ?? s}</span>;
}

/** Stacked bar: what's done vs what still needs a human. */
export function ProgressBar({ p }: { p: Progress }) {
  if (!p.total) return <span className="muted">—</span>;
  const seg = (n: number, cls: string, title: string) =>
    n > 0 ? <span className={`seg ${cls}`} style={{ flexGrow: n }} title={`${n} ${title}`} /> : null;
  return (
    <div className="progress">
      <div className="bar">
        {seg(p.approved, "approved", "approved")}
        {seg(p.corrected, "corrected", "corrected")}
        {seg(p.carried_over, "carried", "carried over")}
        {seg(p.pending, "pending", "pending")}
      </div>
      <span className="progress-label">
        {p.pending > 0 ? <strong>{p.pending} to review</strong> : <span className="ok">All reviewed</span>}
        <span className="muted"> · {p.total - p.pending}/{p.total} done</span>
      </span>
    </div>
  );
}
