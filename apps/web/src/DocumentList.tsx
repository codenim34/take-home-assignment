import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isActive } from "./api";
import { ProgressBar, StatusBadge } from "./components";

export function DocumentList() {
  const qc = useQueryClient();
  // Poll only while something is queued/extracting; otherwise refresh on focus.
  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: api.list,
    refetchInterval: (q) => (q.state.data?.some((d) => isActive(d.status)) ? 2000 : false),
  });

  const [type, setType] = useState("invoice");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => api.upload(file!, type, title),
    onSuccess: () => {
      setTitle("");
      setFile(null);
      (document.getElementById("upload-file") as HTMLInputElement).value = "";
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (file) upload.mutate();
  };

  const totalPending = docs.data?.reduce((n, d) => n + d.progress.pending, 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="muted">
            {docs.data ? (totalPending ? `${totalPending} values waiting for review` : "Nothing waiting for review") : " "}
          </p>
        </div>
        <form className="upload" onSubmit={onSubmit}>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type">
            <option value="invoice">Invoice</option>
            <option value="lease">Lease</option>
            <option value="market_report">Market report</option>
          </select>
          <input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input id="upload-file" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" disabled={!file || upload.isPending}>
            {upload.isPending ? "Uploading…" : "Upload PDF"}
          </button>
          {upload.error && <span className="error">{upload.error.message}</span>}
        </form>
      </div>

      {docs.isLoading && <p className="muted">Loading…</p>}
      {docs.error && <p className="error">Could not load documents: {docs.error.message}</p>}
      {docs.data && (
        <table className="doc-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Version</th>
              <th>Status</th>
              <th>Review progress</th>
            </tr>
          </thead>
          <tbody>
            {docs.data.map((d) => (
              <tr key={d.id} onClick={() => (window.location.hash = `#/documents/${encodeURIComponent(d.id)}`)}>
                <td>
                  <a href={`#/documents/${encodeURIComponent(d.id)}`}>{d.title}</a>
                  {d.status === "failed" && d.error && <div className="error small">{d.error}</div>}
                </td>
                <td className="muted">{d.type.replace("_", " ")}</td>
                <td>v{d.version}</td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td>
                  <ProgressBar p={d.progress} />
                </td>
              </tr>
            ))}
            {docs.data.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No documents yet. Upload a PDF to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
