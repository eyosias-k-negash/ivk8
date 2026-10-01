# Ivy Wallet Analytics Service: Lean Plan (v2)

This is the single source of truth for **analytics rules, scope and estimates**. How the services, security and delivery pipeline fit together lives in `claude/ARCHITECTURE.md` (mirror of `docs/architecture.md` in the repo). The two docs must not contradict each other.

## 1. Estimate

| Tier | Scope | Hours |
|------|-------|-------|
| **0: MVP** | Ingest + validate, currency conversion (live + manual override), balances/net worth, summaries/timeseries with timezone, API | **~34** |
| **1: Core insights** | Budgets vs actual, planned-payments view, tag breakdown, top payees | **+11** |
| **2: Nice-to-have** | Anomaly flags, recurring-rule adherence | **+8** |
| | **Total if everything ships** | **~53** |

**Commit to Tier 0 + Tier 1: ~45h, ~52h with a 15% buffer.** One developer: about 7 working days. Two developers: about 4 to 5 days.

What changed from v1: loans/loan records are out of scope (saves ~5h), but multi-currency moved from optional to core (adds ~8h) because every figure is now converted to the base currency. Net effect is ~+5h on the committed scope.

Assumptions: TypeScript/Node, backups under ~100k transactions. These estimates cover **analytics-service only**. The dashboard (`web-dashboard`) and Drive access (`drive-sync-service`) are separate services (see ARCHITECTURE.md); the dashboard sends the timezone and rate overrides described below.

## Status (2026-10-01)

Code lives in `services/analytics-service/` (monorepo rescaffold, see ARCHITECTURE.md).

| Item | State |
|---|---|
| Types, rules, loader + validation + warnings, timezone bucketing, balance engine, FX conversion core | done, tested |
| Rate fetching: ECB daily XML, 1 h cache, stale flag, optional fallback provider hook, overrides, `ratesUsed` | done, tested |
| API wiring (Fastify), param parsing, error envelope | done, tested |
| Reports: transactions table, balances / net worth | done |
| Reports: summary, timeseries (Tier 0); budgets, planned, tags, payees (Tier 1) | routes return `501`; next |
| Sanity check + golden test on a real backup | not started |

54 tests pass, typecheck clean. Roughly 22 to 25 of the Tier 0 hours are spent.

## 2. Architecture: stateless and in-memory

```
backup.json -> validate (ajv vs schema-new.json) -> index (Maps) -> pure functions(data, params) -> JSON API
                                                            ^
                                   params = { tz, rateOverrides, range, ... }
```

- No database, no Redis, no pre-aggregates. The dataset is parsed once and held in an in-memory LRU, keyed by an opaque key that drive-sync supplies (`sha256(user, fileId, Drive md5)`). On a cache miss drive-sync re-uploads the backup.
- **Timezone and rate overrides are request parameters, not stored state.** "Change it and recalculate" is therefore just calling the endpoint again with new params; no recompute pipeline is needed.
- One more small in-memory cache: fetched FX rates with a TTL (see section 4).
- Stack: Node 22 + TypeScript, `ajv`, Fastify, Vitest.

## 3. Day 0 decisions (resolved)

| # | Decision |
|---|----------|
| 1 | `categoryIdsSerialized` = comma-separated category UUIDs. `accountIdsSerialized` is vestigial and **ignored**. |
| 2 | Budgets apply per **calendar month**, starting on the 1st. |
| 3 | Live exchange rates from official APIs; all analysis converted to `settings.currency` (base). Rates are **manually overridable** and totals recalculate. |
| 4 | `loans` and `loanRecords` arrays are **ignored**. Transactions with `loanId`/`loanRecordId` are **normal transactions** and count toward income/expense. |
| 5 | `dueDate != null` means **planned, not executed**. It may be future or overdue. |
| 6 | Default timezone **GMT+3**; changeable per request, with results recalculated. |
| 7 | Loan entities fully ignored (same as 4). |
| 8 | Missing `tags` / `tagAssociations` = empty. |
| 9 | A budget with an **empty category list is a shell budget: ignored** (not "all categories"). Counted in a warning, excluded from budget output. |
| 10 | `dueDate` = when planned for; `dateTime` = when executed. A transaction with **both** is treated as **planned** (confirmed). This lives in one flag (`plannedWins` in `rules.ts`) and is surfaced as a warning count so it is easy to revisit. |

Implementation remark: there is no `settings` row guaranteed to exist, so if `settings` is empty, fail ingest with a clear error about the missing base currency. If there are several, use the first and warn.

## 4. Currency module (core, ~8h)

**Rates source.** Use the ECB euro reference rates (free, keyless, published via the ECB Data Portal SDMX API; Frankfurter is a thin wrapper around the same data). Two limits matter:

- **Coverage is about 30 currencies.** Compare the currencies on your accounts against the ECB list before relying on it. Anything missing needs a **fallback provider** (pick one at build time; verify its terms and coverage). Unconverted currencies must be reported, never silently dropped. **Known gap: ETB is not published by the ECB**, so an ETB base needs the fallback provider (`FALLBACK_RATES_URL`) or manual overrides.
- **It is not live.** ECB rates update once per working day (around 16:00 CET). "Live" in practice means the latest daily reference rate. If you need intraday rates, a different provider is required.

**Design**
- `getRates(base)` fetches the latest rates, caches in memory (TTL ~1h), and on fetch failure serves the last cached rates with a `stale: true` flag. If there is no cache, conversion for affected currencies is marked unavailable.
- Cross rates via EUR: `rate(A->B) = rate(EUR->B) / rate(EUR->A)`.
- **Manual overrides:** request param `rateOverrides={"USD": 130.5}` meaning 1 unit of USD = 130.5 base units. Overrides win over fetched rates.
- Every analytics response includes `ratesUsed`: `[{ currency, rateToBase, source: "manual" | "live" | "fallback" | "unavailable", fetchedAt, stale? }]`, so the dashboard can render an editable rates table.
- **Approximation to accept:** one current rate per currency is applied to *all* transactions, including historical ones. Historical income/expense in a foreign currency is therefore converted at today's rate, not the rate at the time. Per-date historical rates are out of scope for now.

## 5. Core calculation rules

Global rules, applied everywhere:

1. **Skip** any entity with `isDeleted === true`; missing flags are `false`. Missing `includeInBalance` is `true`.
2. **Executed transaction:** `dueDate == null && dateTime != null`.
3. **Planned transaction:** `dueDate != null` (regardless of `dateTime`). Status: `OVERDUE` if `dueDate < now`, otherwise `UPCOMING`. Planned transactions are **excluded** from balances, income/expense, budgets, and timeseries.
4. **Integrity warning** (excluded, not fatal): `dueDate == null && dateTime == null`.
5. **Currency:** a transaction's currency is its source account's currency (`account.currency`, falling back to base if null). All reported totals are converted to base; native amounts are retained in per-account output.
6. **Time bucketing:** convert `dateTime` (epoch ms) using the request's timezone (default `+03:00`) before assigning day/week/month/year. Week start: Monday.
7. **Loan fields:** `loanId` and `loanRecordId` are ignored entirely. Those transactions follow the same rules as any other.

```ts
// Account balance in native currency as of `asOf` (executed transactions only)
for (const t of txs) {
  if (t.isDeleted || t.dueDate != null || t.dateTime == null || t.dateTime > asOf) continue;
  switch (t.type) {
    case 'INCOME':   bal[t.accountId] += t.amount; break;
    case 'EXPENSE':  bal[t.accountId] -= t.amount; break;
    case 'TRANSFER':
      bal[t.accountId] -= t.amount;
      if (t.toAccountId) bal[t.toAccountId] += t.toAmount ?? t.amount;
      break;
  }
}
// Net worth (base currency) = sum over accounts with includeInBalance !== false of
//   convert(bal[account], account.currency -> base)
```

- **Income/expense summary:** executed INCOME and EXPENSE only, converted to base. TRANSFER is excluded from both. Loan-linked transactions are included.
- **Budget (Tier 1):**
  - `categoryIds = categoryIdsSerialized?.split(',').map(trim).filter(Boolean) ?? []`; `accountIdsSerialized` ignored.
  - Period = calendar month containing the requested date, computed in the request's timezone, from the 1st 00:00 to the next month's 1st 00:00.
  - A budget with an empty `categoryIds` list is a **shell budget and is ignored** (decision 9). It is dropped at ingest and reported via a `SHELL_BUDGETS` warning.
  - `spent = Σ convert(amount)` over executed EXPENSE transactions in the period whose `categoryId` is in `categoryIds`, across all accounts.
  - `budget.amount` is assumed to be in base currency (the schema has no budget currency).
  - Projection: `spent / daysElapsed * daysInMonth`, shown only after day 7 of the month.
- **Planned view (Tier 1):** list planned transactions with status, due date, converted amount, and totals for overdue and upcoming.
- **Tags (Tier 1):** join via `tagAssociations` where `associatedId` is a transaction id; skip deleted associations; a transaction with several tags counts once per tag in the tag breakdown (so tag totals can exceed the overall total; note this in the response).
- **Anomalies (Tier 2):** per category, flag executed EXPENSE transactions above `Q3 + 1.5*IQR` (base currency), requiring at least 10 transactions in the category.

## 6. API (analytics-service, cluster-internal)

Only drive-sync calls these; the browser reaches the same reports as `/api/backups/:fileId/<report>`. Types live in `packages/contracts`.

| Endpoint | Returns |
|----------|---------|
| `PUT /datasets/:key` | Validates and loads the backup; returns entity counts and integrity warnings |
| `HEAD /datasets/:key` | 200 if loaded, 404 if drive-sync must re-upload |
| `GET /datasets/:key/rates` | Rates used, with source and staleness |
| `GET /datasets/:key/transactions` | Transaction table rows (native + base amount, status, tags) |
| `GET /datasets/:key/balances?asOf=` | Per-account native balance + base-converted balance, net worth |
| `GET /datasets/:key/summary?from=&to=` | Income, expense, net; by category; by account |
| `GET /datasets/:key/timeseries?from=&to=&granularity=&groupBy=` | Bucketed income/expense, optional category/account split |
| `GET /datasets/:key/budgets?date=` *(Tier 1)* | Budget status list |
| `GET /datasets/:key/planned` *(Tier 1)* | Overdue and upcoming planned transactions |
| `GET /datasets/:key/tags`, `/payees` *(Tier 1)* | Tag breakdown, top payees |

Every report accepts `tz` (default `+03:00`) and `rateOverrides`, and returns `{ baseCurrency, tz, ratesUsed, warnings, data }`.

## 7. Work breakdown

### Tier 0 (~34h)
| Task | h | State |
|------|---|---|
| Sanity check on a real backup (confirm `toAmount`, currencies in use vs. ECB coverage, settings row) | 1 | todo |
| Setup, ajv validation, loader, indexes | 4 | done |
| Currency module (fetch, cache, fallback, cross rates, overrides, `ratesUsed`) | 8 | done (fallback provider not chosen) |
| Balance / net-worth engine | 4 | done |
| Summary + timeseries + breakdowns, timezone-aware, converted | 7 | todo |
| API wiring, param parsing, error handling | 4 | done |
| Golden tests + mocked-rate tests | 6 | mocked-rate done; golden todo |

### Tier 1 (~11h)
| Task | h |
|------|---|
| Budgets vs actual + projection | 5 |
| Planned view | 3 |
| Tag breakdown | 2 |
| Top payees by `title` | 1 |

### Tier 2 (~8h)
| Task | h |
|------|---|
| Anomaly flags | 3 |
| Recurring-rule adherence (`plannedPaymentRules` vs transactions) | 5 |

### Cut
Loans and loan records, Redis/DB/pre-aggregates, historical per-date FX, intraday FX, ML forecasting, pattern discovery, geo analytics, exports. (Deployment and security hardening are in scope at the project level and tracked in ARCHITECTURE.md, not in these hours.)

## 8. Schedule (one developer)

| Day | Work |
|-----|------|
| 1 | Sanity check, setup, validation, loader/indexes |
| 2 | Currency module |
| 3 | Balances/net worth, summary |
| 4 | Timeseries, API wiring, golden tests |
| 5 | Budgets, planned view |
| 6 | Tags, payees, tests |
| 7 | Buffer, README. Tier 2 only if ahead |

## 9. Testing

- **Golden-file tests** on a sanitized real backup: balances and monthly totals must match the Ivy app (using the same base currency).
- **Timezone tests:** a transaction at 22:30 UTC on the last day of a month falls in the next month at `+03:00`. This is the most likely boundary bug.
- **Planned tests:** dueDate in the past (overdue) and future (upcoming) both excluded from balances; `dueDate` set with `dateTime` set is still planned.
- **FX tests:** mocked fetch success, failure with cache (stale flag), failure without cache (unavailable), override beats live.
- Unit tests for the comma-separated id parser (whitespace, empty string, null).

## 10. Definition of done

- Tier 0 + Tier 1 endpoints match the Ivy app for one real backup (balances, one month's totals, one budget).
- Changing `tz` or `rateOverrides` changes results consistently, with no stored state.
- Unconvertible currencies and malformed rows produce warnings, not crashes.
- README with endpoint examples and the decisions above.

## 11. Remaining risks

| Risk | Mitigation |
|------|-----------|
| A currency in use is not covered by the ECB (confirmed for ETB) | Choose a fallback provider in the sanity step; until then, manual overrides |
| Historical income/expense converted at today's rate | Documented approximation; per-date rates are a later enhancement |
| Transactions with both `dateTime` and `dueDate` | Treated as planned (decision 10); count surfaced as `PLANNED_WITH_DATETIME`. If golden tests disagree with the app, flip `plannedWins` |
| Schema validation stricter than real backups (e.g. `format: uuid` on optional ids) | The 1h sanity check on a real backup will show this; relax the validator if needed |
