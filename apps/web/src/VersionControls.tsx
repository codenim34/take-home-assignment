import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type DocumentDetail } from "./api";

/** Version switching, new-version upload and the per-version run log. */

export function VersionPicker({ d }: { d: DocumentDetail }) {
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

export function NewVersionUpload({ id, onDone }: { id: string; onDone: () => void }) {
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

export function RunLog({ id, version }: { id: string; version: number }) {
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
