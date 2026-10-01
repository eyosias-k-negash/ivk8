# 0002. Sessions in an encrypted cookie

- Status: accepted (2026-10-01)

## Context
drive-sync must keep the Google refresh token between requests. Without a database, the options are a server-side store (Redis) or the client.

## Decision
Seal the session `{sub, email, tokens, folder}` with AES-256-GCM (key via HKDF from `SESSION_SECRET`). Store it in an `HttpOnly`, `SameSite=Lax`, `Secure` (over HTTPS) cookie scoped to `/api`, with a 7-day max age. State-changing calls also need an `x-ivy-csrf: 1` header.

## Consequences
- drive-sync is stateless and scales horizontally. There is nothing to back up or breach server-side.
- Logout clears the cookie. A stolen cookie stays valid until it expires, so rotating `SESSION_SECRET` is the global kill switch.
- The cookie must stay under about 4 KB, which it does with Google's token sizes.
