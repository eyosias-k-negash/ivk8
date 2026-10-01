/**
 * Client for the cluster-internal analytics-service. NetworkPolicy allows only
 * drive-sync-service to reach it, so it needs no auth of its own.
 */
export interface Proxied {
  status: number;
  body: unknown;
}

export class AnalyticsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async ingest(key: string, bytes: Buffer): Promise<Proxied> {
    const res = await this.fetchFn(`${this.baseUrl}/datasets/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async report(key: string, report: string, query: URLSearchParams): Promise<Proxied> {
    const qs = query.toString();
    const res = await this.fetchFn(`${this.baseUrl}/datasets/${key}/${report}${qs ? `?${qs}` : ''}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
}
