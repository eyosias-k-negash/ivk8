# 0001. Three stateless TypeScript services, no database

- Status: accepted (2026-10-01)
- Supersedes: the earlier scaffold (Go drive-sync, Python analytics, Postgres, Redis)

## Context
The lean plan keeps all analytics in memory and treats timezone and rate overrides as request parameters. Nothing needs to persist between requests. The earlier scaffold mixed three languages and two datastores, which added work without serving any user flow.

## Decision
- Three services, all TypeScript on Node 22, in one npm-workspaces repo: `web-dashboard`, `drive-sync-service` (public BFF) and `analytics-service` (internal).
- Shared API types in `packages/contracts`.
- No Postgres and no Redis. Parsed datasets live in an in-memory LRU in analytics. On a cache miss, drive-sync re-uploads the backup.

## Consequences
- One toolchain, one lockfile, one test runner. Contracts are type-checked end to end.
- Restarting analytics costs one re-download per open backup. That is acceptable at MVP scale.
- Scaling analytics past one replica works but duplicates uploads. Sticky routing by dataset key is the upgrade path if that ever matters.
