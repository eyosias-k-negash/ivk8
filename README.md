# Ivy Wallet Plus

A personal finance dashboard for [Ivy Wallet](https://github.com/Ivy-Apps/ivy-wallet) users. Sign in with Google, point it at the Drive folder that holds your Ivy backups, and browse transactions, balances, reports and insights. Access to Drive is **read-only**, and nothing about you is stored.

It is also a DevOps portfolio project. It runs as three stateless services on Kubernetes and ships through a pipeline that tests it, scans it, deploys it to a throwaway cluster and signs the images.

```
Browser ─► Ingress ─┬─ /     ─► web-dashboard       (React + Vite, nginx)
                    └─ /api  ─► drive-sync-service  (Google OAuth, Drive read-only, BFF)
                                     └─► analytics-service (internal: rules, FX, reports)
```

Details: [docs/architecture.md](docs/architecture.md) · decisions: [docs/adr](docs/adr) · analytics rules: `ANALYTICS-PLAN-LEAN.md` (project doc).

## Quick start (one command)

Prerequisites: Docker, [k3d](https://k3d.io), kubectl, Node 22 (only for local dev and tests).

1. Create a Google OAuth client (type **Web application**) and add the redirect URI `http://localhost:8080/api/auth/callback`. Enable the Drive API. Add yourself as a test user.
2. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` (`openssl rand -hex 32`).
3. Start everything:

```bash
make up      # k3d cluster → build images → secret → kustomize apply → wait
open http://localhost:8080
make smoke   # optional: end-to-end checks incl. NetworkPolicy
make down    # delete the cluster
```

### Fast dev loop (no cluster)

```bash
npm ci
npm run dev:analytics                                     # :8081
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… SESSION_SECRET=… \
  PUBLIC_BASE_URL=http://localhost:5173 ANALYTICS_URL=http://localhost:8081 \
  npm run dev:drive                                       # :8080
npm run dev:web                                           # :5173, proxies /api → :8080
```

For this loop, also add `http://localhost:5173/api/auth/callback` as a redirect URI.

## User flows

| # | Flow | Where |
|---|---|---|
| 1 | Sign in with Google, grant read-only Drive, pick folder; reconnect prompt if access expires | `ConnectPage`, `FolderPicker`, `REAUTH_REQUIRED` handling |
| 2 | List every backup version, newest first | `BackupsPage` → `GET /api/backups` |
| 3 | Sortable / filterable transaction table | `TransactionsTable` (TanStack Table) |
| 4 | Balances & net worth as of a date; income/expense by category & account; trends | `BackupView` tabs |
| 5 | Budgets vs actual + projection, planned (overdue/upcoming), tags, top payees | `BackupView` tabs |
| 6 | Change timezone / override any FX rate → instant recalculation, nothing stored | `params.tsx` + query params |
| 7 | Data-quality warnings instead of failures | `Warnings` component, `warnings[]` on every response |

## Business rules (summary)

- Totals are in the backup's base currency. Each transaction uses its account's currency. Per-account views also show native amounts.
- Exchange rates are the latest ECB daily rates, with an optional fallback provider. Manual overrides win. Failed refreshes serve the last rates marked **stale**. Currencies without a rate are reported, never silently dropped.
- Default timezone is **GMT+3**. Weeks start on Monday.
- A transaction with a `dueDate` is **planned** (overdue or upcoming) even if it also has a `dateTime`. Planned items never count toward balances, totals, budgets or trends.
- Transfers are not income or expense. Deleted items are ignored. Accounts excluded from balance don't count toward net worth. Loan records are ignored, but loan-linked transactions count normally.
- Budgets run per calendar month across all accounts and count expenses in their categories only. Budgets with no categories are ignored and produce a warning. The projection appears after day 7.
- A transaction with several tags counts once per tag, so tag totals can exceed the overall total.

## Repository layout

```
packages/contracts/        shared API types (types only)
services/analytics-service/ Fastify, ajv, pure report functions, ECB rates
services/drive-sync-service/ Fastify, OAuth (PKCE), Drive v3 client, encrypted-cookie session
services/web-dashboard/    React + Vite + TanStack Query/Table + Recharts, nginx image
k8s/base/                  Deployments, Services, Ingress, NetworkPolicies, PSA-restricted namespace
k8s/overlays/{local,ci}/   image tags, ingress class, replicas
scripts/                   k3d-up/down, build-images, create-secrets, smoke-test
.github/workflows/         ci.yml (test → scan → deploy-to-k3d → smoke), release.yml (GHCR + SBOM + cosign)
docs/                      architecture + ADRs
```

## Pipeline

| Gate | Tool | Blocks on |
|---|---|---|
| Types, unit and API tests, build | tsc, Vitest, esbuild, Vite | any failure |
| Dependencies | `npm audit --omit=dev` | high/critical |
| Secrets | gitleaks | any finding |
| Manifests | kubeconform, Trivy config | invalid schema, HIGH/CRITICAL misconfig |
| Images | Trivy image | fixable HIGH/CRITICAL CVEs |
| Deploy | ephemeral k3d + `smoke-test.sh` | rollout failure, failed smoke check, NetworkPolicy not enforced |
| Release (main) | buildx, GHCR, cosign | n/a: SBOM + provenance + signature |

Make the CI jobs required status checks on `main` so a failing gate blocks the merge.

## Status

| Area | State |
|---|---|
| Engine: validation, rules, timezone bucketing, balances, FX core | done, tested |
| FX fetching: ECB, cache, stale, fallback hook, overrides, `ratesUsed` | done, tested |
| Reports: transactions, balances / net worth | done |
| Reports: summary, timeseries, budgets, planned, tags, payees | routes return `501`; next per plan §7 |
| drive-sync: OAuth, session, folder, listing, size limit, backoff, proxy + re-ingest | done, tested |
| Dashboard: all flows wired; unimplemented reports show "coming soon" | scaffolded |
| k8s, CI and release | written; first real run pending |
| Golden test against a real backup | pending (needs a sanitized real backup) |

## Known limitations

- Historical amounts are converted at **today's** rate.
- Timezones are fixed UTC offsets (no DST).
- The ECB has no ETB rate. With an ETB base, configure `FALLBACK_RATES_URL` or enter overrides.
- Only `.json` backups are listed (no zip support yet).
- `drive.readonly` is a restricted Google scope, so this runs in OAuth testing mode until Google verifies the app.
- No long-lived production cluster yet. Images are published and signed, and promotion is a next step ([ADR 0004](docs/adr/0004-kubernetes-only-delivery.md)).
