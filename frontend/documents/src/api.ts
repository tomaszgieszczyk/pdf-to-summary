import { MissingDocument } from "../../shared/events";
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) throw new MissingDocument(data.detail);
    throw new Error(data.detail || `Request failed (${response.status})`);
  }
  return response.json();
}
