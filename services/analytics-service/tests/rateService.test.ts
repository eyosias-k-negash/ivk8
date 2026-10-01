import { describe, it, expect } from 'vitest';
import { RateService, parseEcbXml, type Fetcher } from '../src/rates/rateService';

const ECB = `<Cube><Cube time='2026-09-30'>
  <Cube currency='USD' rate='1.10'/><Cube currency='GBP' rate='0.85'/>
</Cube></Cube>`;

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body });

describe('parseEcbXml', () => {
  it('extracts currency/rate pairs', () => {
    expect(parseEcbXml(ECB)).toEqual(new Map([['USD', 1.1], ['GBP', 0.85]]));
  });
});

describe('RateService', () => {
  it('computes cross rates into the base currency via EUR', async () => {
    const svc = new RateService({ ecbUrl: 'ecb', ttlMs: 1000, fetcher: async () => ok(ECB) });
    const t = await svc.getRates('USD', ['GBP', 'EUR', 'USD']);
    expect(t.get('GBP')?.rateToBase).toBeCloseTo(1.1 / 0.85);
    expect(t.get('EUR')?.rateToBase).toBeCloseTo(1.1);
    expect(t.get('GBP')?.source).toBe('live');
    expect(t.has('USD')).toBe(false); // base is never listed
  });

  it('marks currencies the ECB lacks as unavailable (e.g. ETB base without fallback)', async () => {
    const svc = new RateService({ ecbUrl: 'ecb', ttlMs: 1000, fetcher: async () => ok(ECB) });
    const t = await svc.getRates('ETB', ['USD']);
    expect(t.get('USD')).toMatchObject({ rateToBase: null, source: 'unavailable' });
  });

  it('fills gaps from the fallback provider', async () => {
    const fetcher: Fetcher = async (url) => (url === 'ecb' ? ok(ECB) : ok(JSON.stringify({ rates: { ETB: 165, USD: 999 } })));
    const svc = new RateService({ ecbUrl: 'ecb', fallbackUrl: 'fb', ttlMs: 1000, fetcher });
    const t = await svc.getRates('ETB', ['USD']);
    expect(t.get('USD')?.rateToBase).toBeCloseTo(165 / 1.1); // ECB USD wins over fallback USD
    expect(t.get('USD')?.source).toBe('fallback');
  });

  it('serves the last snapshot as stale when a refresh fails', async () => {
    let now = 0;
    let up = true;
    const svc = new RateService({
      ecbUrl: 'ecb',
      ttlMs: 10,
      now: () => now,
      fetcher: async () => (up ? ok(ECB) : { ok: false, status: 503, text: async () => '' }),
    });
    await svc.getRates('USD', ['GBP']);
    up = false;
    now = 100;
    const t = await svc.getRates('USD', ['GBP']);
    expect(t.get('GBP')).toMatchObject({ source: 'live', stale: true });
  });

  it('reports unavailable when the first fetch fails', async () => {
    const svc = new RateService({ ecbUrl: 'ecb', ttlMs: 10, fetcher: async () => { throw new Error('down'); } });
    const t = await svc.getRates('USD', ['GBP']);
    expect(t.get('GBP')?.source).toBe('unavailable');
  });
});
