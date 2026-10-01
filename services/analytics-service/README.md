# analytics-service

Stateless, in-memory analytics over an Ivy Wallet backup. Internal to the cluster: only `drive-sync-service` may call it (NetworkPolicy). Rules and decisions: `ANALYTICS-PLAN-LEAN.md`.

```bash
npm run dev -w @ivy/analytics-service      # :8081
npm test -w @ivy/analytics-service
```

| Path | Purpose |
|---|---|
| `schema/schema-new.json` | Backup schema (ajv) |
| `src/engine/rules.ts` | Day-0 decisions: planned vs executed, id parsing, shell budgets (`plannedWins` flag) |
| `src/engine/loader.ts` | `ingest(raw)`: validate, index, integrity warnings, base currency |
| `src/engine/time.ts` | Fixed-offset bucketing (default `+03:00`), calendar months |
| `src/engine/balances.ts` | Native balances as of a date |
| `src/engine/currency.ts` | Rate table, overrides, `toBase` |
| `src/rates/rateService.ts` | ECB fetch, 1 h cache, stale fallback, optional fallback provider |
| `src/reports/` | Report builders (transactions, balances; others TODO) |
| `src/server.ts` | Fastify routes, `{ baseCurrency, tz, ratesUsed, warnings, data }` envelope |

Env: `PORT`, `MAX_BACKUP_BYTES`, `DATASET_CACHE_SIZE`, `DATASET_TTL_MS`, `RATES_TTL_MS`, `ECB_URL`, `FALLBACK_RATES_URL`.

Next (plan §7): summary → timeseries → budgets → planned → tags → payees, then the golden test on a sanitized real backup.
