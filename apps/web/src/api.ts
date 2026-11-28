// Response types are derived from the repository functions the API returns,
// so the UI can't silently drift from the server (type-only import, nothing
// from @lomi/db ends up in the browser bundle).
import type { getDocument, listDocuments, listRuns } from "@lomi/db";

/** What JSON.stringify does to a type: Dates become strings. */
type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type DocumentSummary = Jsonify<Awaited<ReturnType<typeof listDocuments>>[number]>;
export type DocumentDetail = Jsonify<Awaited<ReturnType<typeof getDocument>>>;
export type Value = DocumentDetail["values"][number];
export type Run = Jsonify<Awaited<ReturnType<typeof listRuns>>[number]>;
export type Progress = DocumentSummary["progress"];

const BASE = import.meta.env.VITE_API_URL ?? "/api";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? res.statusText);
  return body as T;
}

export const api = {
  list: () => request<{ documents: DocumentSummary[] }>("/documents").then((r) => r.documents),
  get: (id: string, version?: number) =>
    request<DocumentDetail>(`/documents/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`),
  runs: (id: string, version: number) =>
    request<{ runs: Run[] }>(`/documents/${encodeURIComponent(id)}/versions/${version}/runs`).then((r) => r.runs),
  upload: (file: File, type: string, title: string) => {
    const form = new FormData();
    form.append("type", type);
    if (title) form.append("title", title);
    form.append("file", file);
    return request<{ id: string }>("/documents", { method: "POST", body: form });
  },
  uploadVersion: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ version: number; duplicate: boolean }>(`/documents/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: form,
    });
  },
  retry: (id: string) => request(`/documents/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  review: (valueId: string, body: { action: "approve" } | { action: "correct"; value: string; note?: string }) =>
    request(`/values/${valueId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  fileUrl: (id: string, version: number) => `${BASE}/documents/${encodeURIComponent(id)}/versions/${version}/file`,
};

export const isActive = (status: string | null | undefined) => status === "queued" || status === "extracting";

export function formatValue(type: string, v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (type === "money") return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  if (type === "percent") return `${v}%`;
  return v;
}

export const label = (field: string) => field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
