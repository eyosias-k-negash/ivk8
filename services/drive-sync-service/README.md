# drive-sync-service

The only public API (`/api/*`). It handles Google sign-in (OAuth code flow + PKCE, `drive.readonly`), keeps the session in an encrypted cookie, lists backups in the chosen folder, enforces the backup size limit, and retries Drive rate limits and outages. It also proxies reports to `analytics-service`, re-uploading the backup when analytics doesn't have it cached.

```bash
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… SESSION_SECRET=$(openssl rand -hex 32) \
  ANALYTICS_URL=http://localhost:8081 npm run dev -w @ivy/drive-sync-service   # :8080
npm test -w @ivy/drive-sync-service
```

| Path | Purpose |
|---|---|
| `src/auth/google.ts` | OAuth URLs, code exchange, refresh, userinfo (plain `fetch`, no SDK) |
| `src/auth/session.ts` | AES-256-GCM cookie codec |
| `src/drive/driveClient.ts` | Drive v3: folders, backups (newest first), metadata, size-capped download, backoff |
| `src/analytics/analyticsClient.ts` | Internal calls to analytics |
| `src/server.ts` | Routes, CSRF header check, error → user-facing code mapping |

Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (from Secret), `PUBLIC_BASE_URL`, `ANALYTICS_URL`, `MAX_BACKUP_BYTES`, `PORT`.
