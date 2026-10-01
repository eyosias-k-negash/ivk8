import type { RateEntry, RateTable } from '../engine/currency';

/**
 * Latest daily FX rates, EUR-quoted, cached in memory.
 *
 * - Primary: ECB euro reference rates (~30 currencies, once per working day). Source "live".
 * - Fallback (optional): any JSON endpoint returning { rates: { XXX: number } } quoted in EUR,
 *   used only for currencies the ECB lacks. Source "fallback".
 * - On fetch failure the last good snapshot is served with stale=true. With no snapshot at all,
 *   affected currencies are "unavailable" and the caller reports them instead of dropping them.
 */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface Snapshot {
  /** EUR -> X for each currency X (EUR itself = 1). */
  eurTo: Map<string, { rate: number; source: 'live' | 'fallback' }>;
  fetchedAt: Date;
}

export interface RateServiceOptions {
  ecbUrl: string;
  fallbackUrl?: string;
  ttlMs: number;
  fetcher?: Fetcher;
  now?: () => number;
}

export function parseEcbXml(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
  for (const m of xml.matchAll(re)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) out.set(m[1] as string, rate);
  }
  return out;
}

export class RateService {
  private snapshot: Snapshot | null = null;
  private stale = false;
  private inflight: Promise<void> | null = null;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;

  constructor(private readonly opts: RateServiceOptions) {
    this.fetcher = opts.fetcher ?? ((url) => fetch(url, { signal: AbortSignal.timeout(5000) }));
    this.now = opts.now ?? Date.now;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.fetcher(this.opts.ecbUrl);
      if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
      const ecb = parseEcbXml(await res.text());
      if (ecb.size === 0) throw new Error('ECB response had no rates');

      const eurTo: Snapshot['eurTo'] = new Map([['EUR', { rate: 1, source: 'live' }]]);
      for (const [c, r] of ecb) eurTo.set(c, { rate: r, source: 'live' });

      if (this.opts.fallbackUrl) {
        try {
          const fb = await this.fetcher(this.opts.fallbackUrl);
          if (fb.ok) {
            const body = JSON.parse(await fb.text()) as { rates?: Record<string, number> };
            for (const [c, r] of Object.entries(body.rates ?? {})) {
              if (!eurTo.has(c) && Number.isFinite(r) && r > 0) eurTo.set(c, { rate: r, source: 'fallback' });
            }
          }
        } catch {
          /* fallback is best effort; ECB data is still good */
        }
      }
      this.snapshot = { eurTo, fetchedAt: new Date(this.now()) };
      this.stale = false;
    } catch {
      // keep the previous snapshot, mark it stale
      this.stale = this.snapshot != null;
    }
  }

  private async ensureFresh(): Promise<void> {
    const age = this.snapshot ? this.now() - this.snapshot.fetchedAt.getTime() : Infinity;
    if (age < this.opts.ttlMs && !this.stale) return;
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    await this.inflight;
  }

  /** Rate table for `currencies` into `base`. Always returns an entry per currency. */
  async getRates(base: string, currencies: Iterable<string>): Promise<RateTable> {
    await this.ensureFresh();
    const table: RateTable = new Map();
    const snap = this.snapshot;
    const baseEur = snap?.eurTo.get(base);
    for (const c of new Set(currencies)) {
      if (c === base) continue;
      const cEur = snap?.eurTo.get(c);
      const entry: RateEntry & { stale?: boolean } =
        snap && baseEur && cEur
          ? {
              currency: c,
              rateToBase: baseEur.rate / cEur.rate,
              source: baseEur.source === 'fallback' || cEur.source === 'fallback' ? 'fallback' : 'live',
              fetchedAt: snap.fetchedAt.toISOString(),
              ...(this.stale ? { stale: true } : {}),
            }
          : { currency: c, rateToBase: null, source: 'unavailable' };
      table.set(c, entry);
    }
    return table;
  }
}
