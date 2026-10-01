# web-dashboard

React + Vite SPA served by nginx (non-root, strict CSP). It talks only to `/api` (drive-sync). Timezone and rate overrides live in memory and travel as query params, so changing them refetches with no stored state.

```bash
npm run dev -w @ivy/web-dashboard   # :5173, proxies /api → :8080
```
