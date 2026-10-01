import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server';
import { DatasetCache } from '../src/datasets';
import { RateService } from '../src/rates/rateService';
import { ID, makeBackup, tx, utc } from './engine/fixtures';

const ECB = `<Cube currency='USD' rate='1.10'/>`;
const key = createHash('sha256').update('test').digest('hex');

function app() {
  return buildApp({
    logger: false,
    cache: new DatasetCache(4, 60_000),
    rates: new RateService({ ecbUrl: 'ecb', ttlMs: 60_000, fetcher: async () => ({ ok: true, status: 200, text: async () => ECB }) }),
  });
}

const backup = makeBackup({
  transactions: [
    tx({ accountId: ID.cash, type: 'INCOME', amount: 1000, dateTime: utc('2026-09-01T10:00:00Z') }),
    tx({ accountId: ID.usd, type: 'INCOME', amount: 10, dateTime: utc('2026-09-01T10:00:00Z') }),
  ],
});

describe('analytics API', () => {
  it('health', async () => {
    const res = await app().inject('/healthz');
    expect(res.statusCode).toBe(200);
  });

  it('404s for an unknown dataset so drive-sync knows to re-ingest', async () => {
    const res = await app().inject(`/datasets/${key}/balances`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('ingests, then serves balances; ETB base has no ECB rate until overridden', async () => {
    const a = app();
    const put = await a.inject({ method: 'PUT', url: `/datasets/${key}`, payload: backup });
    expect(put.statusCode).toBe(201);
    expect(put.json().baseCurrency).toBe('ETB');

    const noRate = (await a.inject(`/datasets/${key}/balances`)).json();
    expect(noRate.data.netWorth).toBe(1000);
    expect(noRate.data.unconverted).toEqual(['USD']);
    expect(noRate.warnings.map((w: { code: string }) => w.code)).toContain('UNCONVERTIBLE_CURRENCY');

    const q = encodeURIComponent(JSON.stringify({ USD: 130 }));
    const withRate = (await a.inject(`/datasets/${key}/balances?rateOverrides=${q}`)).json();
    expect(withRate.data.netWorth).toBe(2300);
    expect(withRate.ratesUsed).toContainEqual({ currency: 'USD', rateToBase: 130, source: 'manual' });
  });

  it('rejects bad tz and bad overrides with 400', async () => {
    const a = app();
    await a.inject({ method: 'PUT', url: `/datasets/${key}`, payload: backup });
    expect((await a.inject(`/datasets/${key}/balances?tz=Mars/Base`)).statusCode).toBe(400);
    expect((await a.inject(`/datasets/${key}/balances?rateOverrides={"USD":-1}`)).statusCode).toBe(400);
  });

  it('rejects schema-invalid backups with 422', async () => {
    const res = await app().inject({ method: 'PUT', url: `/datasets/${key}`, payload: { nope: true } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SCHEMA_INVALID');
  });

  it('unimplemented reports answer 501, not 404', async () => {
    expect((await app().inject(`/datasets/${key}/summary`)).statusCode).toBe(501);
  });
});
