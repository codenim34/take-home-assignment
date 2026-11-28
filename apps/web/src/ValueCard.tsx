import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, formatValue, label, type Value } from "./api";

const STATE_TEXT: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  corrected: "Corrected",
  carried_over: "Carried over",
};

export function ValueCard({
  v,
  readOnly,
  active,
  onFocus,
  onReviewed,
}: {
  v: Value;
  readOnly: boolean;
  active: boolean;
  onFocus: () => void;
  onReviewed: () => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState(v.effectiveValue ?? "");
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(v.id, body),
    onSuccess: () => {
      setCorrecting(false);
      setNote("");
      onReviewed();
    },
  });

  const isGap = v.value === null;
  const changed = v.change === "changed" && v.previous;
  const submitCorrection = (e: FormEvent) => {
    e.preventDefault();
    review.mutate({ action: "correct", value: draft, note: note || undefined });
  };

  return (
    <article className={`value-card state-${v.reviewState} ${active ? "active" : ""} ${isGap ? "gap" : ""}`} onMouseEnter={onFocus} onClick={onFocus}>
      <header>
        <span className="field">{label(v.field)}</span>
        <span className="tags">
          {changed && <span className="tag changed">Changed since v{v.previous!.version}</span>}
          {isGap && <span className="tag gap">Gap</span>}
          <span className={`tag state ${v.reviewState}`}>{STATE_TEXT[v.reviewState]}</span>
        </span>
      </header>

      <div className="value-row">
        {isGap ? (
          <div className="gap-reason">
            <strong>No value extracted.</strong> {v.gapReason}
          </div>
        ) : (
          <div className="value">
            {v.reviewState === "corrected" || (v.review?.action === "correct" && v.effectiveValue !== v.value) ? (
              <>
                <span className="big">{formatValue(v.fieldType, v.effectiveValue)}</span>
                <span className="was">LLM said {formatValue(v.fieldType, v.value)}</span>
              </>
            ) : (
              <span className="big">{formatValue(v.fieldType, v.effectiveValue)}</span>
            )}
          </div>
        )}
        {!isGap && v.evidence && (
          <blockquote title={v.evidenceMatch === "whitespace" ? "Matched ignoring line breaks" : "Exact match in document text"}>
            “{v.evidence}”
          </blockquote>
        )}
      </div>

      {changed && (
        <div className="previous">
          <span className="muted">Version {v.previous!.version}:</span>{" "}
          <strong>
            {v.previous!.value === null
              ? "gap"
              : formatValue(v.fieldType, v.previous!.review?.action === "correct" ? v.previous!.review.correctedValue : v.previous!.value)}
          </strong>
          {v.previous!.review ? (
            <span className="muted">
              {" "}
              ({v.previous!.review.action === "approve" ? "approved" : "corrected"} by {v.previous!.review.reviewer}
              {v.previous!.review.note ? `: “${v.previous!.review.note}”` : ""})
            </span>
          ) : (
            <span className="muted"> (was not reviewed)</span>
          )}
          {v.previous!.evidence && <div className="prev-quote">“{v.previous!.evidence}”</div>}
        </div>
      )}

      {v.review && (
        <div className="review-note">
          {v.reviewState === "carried_over" ? "Review carried over from the previous version: " : ""}
          {v.review.action === "approve" ? "Approved" : "Corrected"} by {v.review.reviewer}
          {v.review.note ? ` — “${v.review.note}”` : ""}
        </div>
      )}

      {!readOnly && !correcting && (
        <div className="actions">
          <button className="approve" disabled={review.isPending} onClick={() => review.mutate({ action: "approve" })}>
            {isGap ? "Confirm not in document" : v.reviewState === "pending" ? "Approve" : "Approve again"}
          </button>
          <button onClick={() => setCorrecting(true)}>{isGap ? "Enter value" : "Correct"}</button>
        </div>
      )}
      {!readOnly && correcting && (
        <form className="correct-form" onSubmit={submitCorrection}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Correct ${v.fieldType}`} required />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
          <button className="primary" disabled={review.isPending}>
            Save correction
          </button>
          <button type="button" onClick={() => setCorrecting(false)}>
            Cancel
          </button>
        </form>
      )}
      {review.error && <div className="error small">{review.error.message}</div>}
    </article>
  );
}
