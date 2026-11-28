import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isActive, type DocumentDetail, type Value } from "./api";
import { ProgressBar, StatusBadge } from "./components";
import { ValueCard } from "./ValueCard";

export function DocumentView({ id, version }: { id: string; version?: number }) {
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ["document", id, version ?? "current"],
    queryFn: () => api.get(id, version),
    // Poll only while this version is still being extracted.
    refetchInterval: (q) => (isActive(q.state.data?.version.status) ? 2000 : false),
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["document", id] });
    qc.invalidateQueries({ queryKey: ["documents"] });
  };
  const retry = useMutation({ mutationFn: () => api.retry(id), onSuccess: refresh });

  if (doc.isLoading) return <p className="page muted">Loading…</p>;
  if (doc.error) return <p className="page error">Could not load document: {doc.error.message}</p>;
  const d = doc.data!;
  const v = d.version;
  const readOnly = !v.isCurrent || v.status !== "extracted";

  const needs = d.values
    .filter((x) => x.reviewState === "pending")
    .sort((a, b) => rank(a) - rank(b));
  const done = d.values.filter((x) => x.reviewState !== "pending");
  const lastExtracted = [...d.versions].reverse().find((x) => x.status === "extracted" && x.version !== v.version);

  return (
    <div className="page">
      <a href="#/" className="back">
        ← All documents
      </a>
      <div className="page-head">
        <div>
          <h1>{d.document.title}</h1>
          <div className="meta">
            <StatusBadge status={v.status} />
            <VersionPicker d={d} />
            <span className="muted">{d.document.type.replace("_", " ")}</span>
            <a href={api.fileUrl(id, v.version)} target="_blank" rel="noreferrer">
              View PDF
            </a>
          </div>
        </div>
        {v.isCurrent && <NewVersionUpload id={id} onDone={refresh} />}
      </div>

      {!v.isCurrent && (
        <div className="banner info">
          You are viewing version {v.version}, which is read-only ({v.status}).{" "}
          <a href={`#/documents/${encodeURIComponent(id)}`}>Go to the current version</a>
        </div>
      )}
      {isActive(v.status) && (
        <div className="banner info">
          <span className="spinner" /> Version {v.version} is {v.status === "queued" ? "queued for extraction" : "being extracted"}. Values
          appear here when it finishes{v.attempts > 1 ? ` (attempt ${v.attempts})` : ""}.
          {v.status === "queued" && v.retryAt && v.error && (
            <>
              {" "}
              The last attempt hit a temporary LLM error, so it will retry at {new Date(v.retryAt).toLocaleTimeString()}. <span className="muted">({v.error})</span>
            </>
          )}
          {lastExtracted && (
            <>
              {" "}
              <a href={`#/documents/${encodeURIComponent(id)}?v=${lastExtracted.version}`}>View version {lastExtracted.version}</a> meanwhile.
            </>
          )}
        </div>
      )}
      {v.status === "failed" && (
        <div className="banner danger">
          <div>
            <strong>Extraction failed.</strong> {v.error}
          </div>
          {v.isCurrent && (
            <button className="primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? "Retrying…" : "Retry extraction"}
            </button>
          )}
        </div>
      )}

      {v.status === "extracted" && (
        <>
          <div className="summary">
            <ProgressBar p={d.progress} />
            <SummaryCounts d={d} />
          </div>
          <div className="review-grid">
            <section>
              {v.isCurrent && (
                <>
                  <h2>
                    Needs your review <span className="count">{needs.length}</span>
                  </h2>
                  {needs.length === 0 && <p className="empty">Nothing left to review in this version.</p>}
                  {needs.map((x) => (
                    <ValueCard key={x.id} v={x} readOnly={readOnly} active={activeId === x.id} onFocus={() => setActiveId(x.id)} onReviewed={refresh} />
                  ))}
                </>
              )}
              <h2>
                {v.isCurrent ? "Reviewed" : "Values"} <span className="count">{v.isCurrent ? done.length : d.values.length}</span>
              </h2>
              {(v.isCurrent ? done : d.values).map((x) => (
                <ValueCard key={x.id} v={x} readOnly={readOnly} active={activeId === x.id} onFocus={() => setActiveId(x.id)} onReviewed={refresh} />
              ))}
            </section>
            <DocumentText text={d.parsedText ?? ""} values={d.values} activeId={activeId} onPick={setActiveId} />
          </div>
          <RunLog id={id} version={v.version} />
        </>
      )}
    </div>
  );
}

/** Changed values first (the reviewer approved something that moved), then gaps, then new ones. */
function rank(v: Value) {
  if (v.change === "changed" && v.previous) return 0;
  if (v.value === null) return 1;
  return 2;
}

function SummaryCounts({ d }: { d: DocumentDetail }) {
  const p = d.progress;
  const items = [
    ["pending", p.pending, "pending"],
    ["approved", p.approved, "approved"],
    ["corrected", p.corrected, "corrected"],
    ["carried", p.carried_over, "carried over"],
    ["gap", p.gaps, "gaps"],
  ] as const;
  return (
    <div className="counts">
      {items.map(([cls, n, text]) => (
        <span key={cls} className={`chip ${cls}`}>
          {n} {text}
        </span>
      ))}
    </div>
  );
}

function VersionPicker({ d }: { d: DocumentDetail }) {
  return (
    <select
      value={d.version.version}
      aria-label="Version"
      onChange={(e) => {
        const n = Number(e.target.value);
        const cur = d.versions.find((x) => x.id === d.document.currentVersionId)?.version;
        window.location.hash = `#/documents/${encodeURIComponent(d.document.id)}${n === cur ? "" : `?v=${n}`}`;
      }}
    >
      {[...d.versions].reverse().map((x) => (
        <option key={x.id} value={x.version}>
          v{x.version} · {x.status}
          {x.id === d.document.currentVersionId ? " (current)" : ""}
        </option>
      ))}
    </select>
  );
}

function NewVersionUpload({ id, onDone }: { id: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const up = useMutation({
    mutationFn: (f: File) => api.uploadVersion(id, f),
    onSuccess: () => {
      if (input.current) input.current.value = "";
      onDone();
    },
  });
  return (
    <div className="new-version">
      <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} />
      <button onClick={() => input.current?.click()} disabled={up.isPending}>
        {up.isPending ? "Uploading…" : "Upload new version"}
      </button>
      {up.data?.duplicate && <span className="muted small">Same file as the current version; nothing changed.</span>}
      {up.error && <span className="error small">{up.error.message}</span>}
    </div>
  );
}

/** The parsed text of THIS version, with every quote marked and the active one emphasised. */
function DocumentText({
  text,
  values,
  activeId,
  onPick,
}: {
  text: string;
  values: Value[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const activeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeId]);

  const pieces = useMemo(() => {
    const ranges = values
      .filter((v) => v.evidenceStart !== null && v.evidenceEnd !== null)
      .map((v) => ({ id: v.id, start: v.evidenceStart!, end: v.evidenceEnd! }))
      .sort((a, b) => a.start - b.start);
    const out: { text: string; id?: string }[] = [];
    let pos = 0;
    for (const r of ranges) {
      if (r.start < pos) continue; // overlapping quotes: keep the first
      if (r.start > pos) out.push({ text: text.slice(pos, r.start) });
      out.push({ text: text.slice(r.start, r.end), id: r.id });
      pos = r.end;
    }
    out.push({ text: text.slice(pos) });
    return out;
  }, [text, values]);

  return (
    <aside className="doc-text">
      <h2>Document text</h2>
      <pre>
        {pieces.map((p, i) =>
          p.id ? (
            <mark
              key={i}
              ref={p.id === activeId ? activeRef : undefined}
              className={p.id === activeId ? "active" : ""}
              onClick={() => onPick(p.id!)}
            >
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </aside>
  );
}

function RunLog({ id, version }: { id: string; version: number }) {
  const [open, setOpen] = useState(false);
  const runs = useQuery({ queryKey: ["runs", id, version], queryFn: () => api.runs(id, version), enabled: open });
  return (
    <details className="runlog" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Extraction runs (prompt and raw LLM response)</summary>
      {runs.data?.map((r) => (
        <div key={r.id} className="run">
          <div>
            Attempt {r.attempt} · <strong>{r.status}</strong> · {r.model} · {new Date(r.startedAt).toLocaleString()}
            {r.error && <span className="error"> · {r.error}</span>}
          </div>
          <pre>{JSON.stringify({ prompt: r.prompt, rawResponse: r.rawResponse }, null, 2)}</pre>
        </div>
      ))}
    </details>
  );
}
