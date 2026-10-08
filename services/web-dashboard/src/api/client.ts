import type { ApiError } from '@ivy/contracts';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: ApiError['error']['code'],
    message: string,
    public details?: string[],
  ) {
    super(message);
  }
}

/** Same-origin fetch to drive-sync-service. Cookies are httpOnly; JS never sees tokens. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-ivy-csrf': '1' } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (body as ApiError | null)?.error;
    throw new ApiFailure(res.status, err?.code ?? 'INTERNAL', err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return body as T;
}

/** Query string for analytics calls. tz + overrides travel on every request; nothing is stored server-side. */
export function analyticsQuery(params: { tz: string; rateOverrides: Record<string, number> }, extra: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams({ tz: params.tz });
  if (Object.keys(params.rateOverrides).length) q.set('rateOverrides', JSON.stringify(params.rateOverrides));
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q.toString();
}
