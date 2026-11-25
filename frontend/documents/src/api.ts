export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || `Request failed (${response.status})`);
  }
  return response.json();
}
