import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { AnalyticsEnvelope, ApiError, IngestResult, RateUsed } from '@ivy/contracts';
import { config } from './config';
import { DatasetCache } from './datasets';
import { applyOverrides, type RateTable } from './engine/currency';
import { IngestError, ingest, type Dataset } from './engine/loader';
import { BadRequest, parseCommon, parseInstant, parseRange } from './params';
import { RateService } from './rates/rateService';
import { budgetTimeseriesReport, budgetsList } from './reports/budgets';
import { balancesReport, currenciesInUse, transactionsTable } from './reports';
import {
  RangeTooLarge,
  earliestExecuted,
  parseGranularity,
  parseGroupBy,
  summaryReport,
  timeseriesReport,
} from './reports/flows';

export interface AppDeps {
  rates?: RateService;
  cache?: DatasetCache;
  logger?: boolean;
}

const KEY_RE = /^[a-f0-9]{64}$/;

function fail(reply: FastifyReply, status: number, code: ApiError['error']['code'], message: string, details?: string[]) {
  const body: ApiError = { error: { code, message, ...(details ? { details } : {}) } };
  return reply.code(status).send(body);
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: config.maxBackupBytes,
    logger:
      deps.logger === false
        ? false
        : {
            level: config.logLevel,
            // Financial data and credentials must never reach logs.
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
          },
  });

  const rates =
    deps.rates ??
    new RateService({ ecbUrl: config.ecbUrl, fallbackUrl: config.fallbackRatesUrl, ttlMs: config.ratesTtlMs });
  const cache = deps.cache ?? new DatasetCache(config.datasetCacheSize, config.datasetTtlMs);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BadRequest || err instanceof RangeTooLarge) return fail(reply, 400, 'BAD_REQUEST', err.message);
    if (err instanceof IngestError) return fail(reply, 422, err.code, err.message, err.details);
    if ((err as { statusCode?: number }).statusCode === 413)
      return fail(reply, 413, 'BACKUP_TOO_LARGE', 'Backup exceeds the size limit');
    const e = err as Error;
    app.log.error({ err: { message: e.message, stack: e.stack } }, 'unhandled');
    return fail(reply, 500, 'INTERNAL', 'Internal error');
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true, datasets: cache.size }));

  // ---- ingest ----
  app.put<{ Params: { key: string } }>('/datasets/:key', async (req, reply) => {
    if (!KEY_RE.test(req.params.key)) throw new BadRequest('dataset key must be a sha256 hex digest');
    const ds = ingest(req.body);
    cache.set(req.params.key, ds);
    const result: IngestResult = {
      datasetKey: req.params.key,
      baseCurrency: ds.baseCurrency,
      counts: {
        accounts: ds.accounts.size,
        categories: ds.categories.size,
        transactions: ds.transactions.length,
        budgets: ds.budgets.length,
      },
      warnings: ds.warnings,
    };
    return reply.code(201).send(result);
  });

  app.head<{ Params: { key: string } }>('/datasets/:key', async (req, reply) =>
    reply.code(cache.get(req.params.key) ? 200 : 404).send(),
  );

  // ---- analytics: shared plumbing ----
  async function withDataset<T>(
    key: string,
    query: Record<string, unknown>,
    reply: FastifyReply,
    build: (ds: Dataset, rates: RateTable, q: Record<string, unknown>) => T,
  ) {
    const ds = cache.get(key);
    if (!ds) return fail(reply, 404, 'NOT_FOUND', 'Dataset not loaded; re-ingest it');
    const { tz, rateOverrides } = parseCommon(query);
    const fetched = await rates.getRates(ds.baseCurrency, currenciesInUse(ds));
    let table: RateTable;
    try {
      table = applyOverrides(fetched, rateOverrides);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
    const ratesUsed: RateUsed[] = [...table.values()];
    const unavailable = ratesUsed.filter((r) => r.rateToBase == null).map((r) => r.currency);
    const warnings = [...ds.warnings];
    if (unavailable.length)
      warnings.push({
        code: 'UNCONVERTIBLE_CURRENCY',
        message: 'No rate available; add a manual override to include these in totals',
        count: unavailable.length,
        examples: unavailable,
      });
    if (ratesUsed.some((r) => r.stale))
      warnings.push({ code: 'STALE_RATES', message: 'Rate refresh failed; using last known rates' });

    const body: AnalyticsEnvelope<T> = {
      baseCurrency: ds.baseCurrency,
      tz,
      ratesUsed,
      warnings,
      data: build(ds, table, { ...query, tz }),
    };
    return reply.send(body);
  }

  type Q = { Params: { key: string }; Querystring: Record<string, unknown> };

  app.get<Q>('/datasets/:key/rates', (req, reply) => withDataset(req.params.key, req.query, reply, () => null));

  app.get<Q>('/datasets/:key/transactions', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds, r) => transactionsTable(ds, r)),
  );

  app.get<Q>('/datasets/:key/balances', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds, r, q) =>
      balancesReport(ds, parseInstant(q.asOf, 'asOf', Date.now()), r),
    ),
  );

  /** from=all means "since the first executed transaction". */
  const range = (ds: Dataset, q: Record<string, unknown>) => {
    const tz = q.tz as string;
    if (q.from === 'all') {
      const first = earliestExecuted(ds);
      return parseRange({ ...q, from: first ?? undefined }, tz);
    }
    return parseRange(q, tz);
  };

  app.get<Q>('/datasets/:key/summary', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds, r, q) => {
      const { from, to } = range(ds, q);
      return summaryReport(ds, from, to, r);
    }),
  );

  app.get<Q>('/datasets/:key/timeseries', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds, r, q) => {
      const granularity = parseGranularity(q.granularity);
      if (!granularity) throw new BadRequest('granularity must be DAY, WEEK, MONTH or YEAR');
      const groupBy = parseGroupBy(q.groupBy);
      if (!groupBy) throw new BadRequest('groupBy must be none, category or account');
      const { from, to } = range(ds, q);
      return timeseriesReport(ds, from, to, granularity, groupBy, q.tz as string, r);
    }),
  );

  app.get<Q>('/datasets/:key/budgets', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds) => budgetsList(ds)),
  );

  app.get<Q>('/datasets/:key/budget-timeseries', (req, reply) =>
    withDataset(req.params.key, req.query, reply, (ds, r, q) => {
      const granularity = parseGranularity(q.granularity);
      if (!granularity) throw new BadRequest('granularity must be DAY, WEEK, MONTH or YEAR');
      if (typeof q.budgetId !== 'string' || !q.budgetId) throw new BadRequest('budgetId is required');
      const { from, to } = range(ds, q);
      const out = budgetTimeseriesReport(ds, q.budgetId, from, to, granularity, q.tz as string, r);
      if (!out) throw new BadRequest('Unknown budgetId');
      return out;
    }),
  );

  // ---- not yet implemented (plan section 7). Routes exist so the contract is visible end to end. ----
  for (const name of ['planned', 'tags', 'payees']) {
    app.get<Q>(`/datasets/:key/${name}`, async (_req, reply) =>
      fail(reply, 501, 'NOT_IMPLEMENTED', `${name} report is not implemented yet`),
    );
  }

  return app;
}
