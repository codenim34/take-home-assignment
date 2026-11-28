import { useEffect, useMemo, useRef } from "react";
import type { Value } from "./api";

/** The parsed text of THIS version, with every quote marked and the active one emphasised. */
export function DocumentText({
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
