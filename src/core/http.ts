const UA =
  "Mozilla/5.0";

type FetchOpts = { retries?: number; timeoutMs?: number; accept?: string };

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { retries = 3, timeoutMs = 15000, accept = "application/json" } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: ctrl.signal });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${url}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt + Math.random() * 300));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T = any>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}

export async function getText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await fetchWithRetry(url, { accept: "text/csv,text/plain,*/*", ...opts });
  return res.text();
}

/** Ejecuta tareas con concurrencia limitada para no saturar las APIs públicas. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Caché en memoria con TTL para que el servidor MCP no golpee las APIs en cada llamada. */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}
