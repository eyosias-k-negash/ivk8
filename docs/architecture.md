# Architecture

Ivy Wallet Plus turns Ivy Wallet backups in a user's Google Drive into reports. It is built as three small, stateless TypeScript services on Kubernetes. Nothing about a user is stored server-side: no database, no Redis, no files on disk.

The analytics rules and estimates live in `ANALYTICS-PLAN-LEAN.md` (project doc). This file covers how the pieces fit together.

## Shape

```
 Browser ──► Ingress (Traefik)
              ├── /      ──► web-dashboard        React SPA, nginx, static only
              └── /api   ──► drive-sync-service   public API (BFF)
                               │  Google OAuth (PKCE), Drive v3 read-only
                               │  encrypted cookie session
                               ▼
                             analytics-service    cluster-internal only
                               │  ajv validate → index → pure report functions
                               ▼
                             ECB daily FX rates (+ optional fallback provider)
```

| Service | Owns | State | Public? |
|---|---|---|---|
| `web-dashboard` | UI for flows 1–7; timezone + rate overrides held in memory | none | yes (`/`) |
| `drive-sync-service` | sign-in, token refresh, folder choice, listing backups, size limit, Drive retries, choosing which bytes to analyse | encrypted cookie only | yes (`/api`) |
| `analytics-service` | validation, business rules, FX, every number on screen | in-memory LRU of parsed datasets + FX cache | **no** (NetworkPolicy) |
| `packages/contracts` | shared request/response types | n/a | n/a |

## Request flow: opening a report

1. The SPA calls `GET /api/backups/:fileId/balances?tz=+03:00&rateOverrides={"USD":130}`.
2. drive-sync decrypts the session cookie and refreshes the Google access token if needed. If the refresh token is dead it returns `401 REAUTH_REQUIRED`, and the UI shows "Reconnect".
3. drive-sync fetches the file's metadata and checks that the file is inside the user's chosen folder.
4. Dataset key = `sha256(user sub, fileId, Drive md5)`. Users never share a cache entry, and a changed file gets a new key.
5. drive-sync asks analytics for the report. A `404` means the dataset is not loaded (first open, evicted, or the pod restarted). drive-sync then downloads the file, enforcing `MAX_BACKUP_BYTES` up front and while streaming, `PUT`s it to analytics, and retries once.
6. analytics computes the report from `(dataset, tz, rateOverrides)` and returns `{ baseCurrency, tz, ratesUsed, warnings, data }`.

"Change it and recalculate" (flow 6) is just the same request with different query params. Nothing is stored.

## API surface

Public (drive-sync), all under `/api`:

| Route | Purpose |
|---|---|
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Google sign-in (PKCE, state check, `drive.readonly`) |
| `GET /me` | signed-in state, email, chosen folder |
| `GET /drive/folders?q=` · `PUT /drive/folder` | find and choose the backups folder |
| `GET /backups` | backup versions in the folder, newest first |
| `GET /backups/:fileId/{transactions,balances,summary,timeseries,budgets,planned,tags,payees,rates}` | reports (proxied) |

Internal (analytics): `PUT /datasets/:key`, `HEAD /datasets/:key`, `GET /datasets/:key/<report>`, `/healthz`, `/readyz`.

Every report accepts `tz` and `rateOverrides` and returns `ratesUsed` and `warnings`.

## Security model

- **Least privilege at Google:** the only Drive scope is `drive.readonly`.
- **Tokens never reach the browser:** the session, including the refresh token, is AES-256-GCM encrypted in an `HttpOnly; SameSite=Lax` cookie scoped to `/api`. State-changing calls also need an `x-ivy-csrf` header.
- **Tenant isolation:** dataset keys include the user's Google `sub`. Analytics is reachable only from drive-sync (NetworkPolicy plus no Ingress route). The smoke test proves both.
- **No sensitive logs:** cookies, auth headers and request bodies are redacted in both APIs.
- **Containers:** distroless (Node) and nginx-unprivileged images, non-root, read-only root FS, all capabilities dropped, seccomp `RuntimeDefault`, and no service-account token. The namespace enforces Pod Security `restricted`.
- **Network:** default-deny ingress and egress. Explicit allows: DNS, ingress-controller → web/drive-sync, drive-sync → analytics, and egress on 443 to the internet for Google and the ECB.
- **Secrets:** `ivy-secrets` is created from a gitignored `.env` by `scripts/create-secrets.sh`, and never committed. gitleaks runs in CI.
- **Abuse limits:** backup size cap (50 MB default) in both services. Drive 429/5xx/rate-limit 403s get exponential backoff with jitter, then a friendly `503`.

## Delivery

| Stage | Where | What |
|---|---|---|
| Local | `make up` | k3d cluster → build 3 images → import → secret → `kubectl apply -k k8s/overlays/local` → wait |
| CI (every PR / main) | `.github/workflows/ci.yml` | typecheck, tests, build, `npm audit`, gitleaks, kubeconform, Trivy config scan, Trivy image scan (blocks fixable HIGH/CRITICAL), deploy to an **ephemeral k3d** cluster, smoke test incl. NetworkPolicy check |
| Release (main, after CI) | `.github/workflows/release.yml` | push images to GHCR with SBOM + provenance, keyless cosign signature |

## Plan → code map

| Plan section | Code |
|---|---|
| §3 Day-0 decisions, §5 global rules | `services/analytics-service/src/engine/rules.ts`, `loader.ts` |
| §5 balances / net worth | `engine/balances.ts`, `reports/index.ts` |
| §4 currency | `engine/currency.ts` (pure), `rates/rateService.ts` (ECB + fallback + stale) |
| §5 timezone bucketing | `engine/time.ts` |
| §6 API | `analytics-service/src/server.ts`, mirrored by `drive-sync-service/src/server.ts` |
| Summary, timeseries, budgets, planned, tags, payees | routes exist and return `501` until implemented in `reports/` |

## Known limitations

- Historical transactions are converted at today's rate (plan §4).
- Timezones are fixed UTC offsets with no DST rules.
- The ECB does not publish ETB. With an ETB base currency, every foreign currency shows as `unavailable` until `FALLBACK_RATES_URL` is configured or the user enters overrides.
- Only `.json` backups are listed. Ivy's zipped exports would need an unzip step in drive-sync.
- `drive.readonly` is a restricted scope, so a public launch needs Google verification. Testing mode (up to 100 test users) is fine for the portfolio.
- No long-lived cluster yet. Release publishes signed images, and promotion (e.g. Argo CD) is a later step.
