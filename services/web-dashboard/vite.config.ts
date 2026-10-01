import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to a locally running drive-sync-service (npm run dev:drive).
// In the cluster, the Ingress routes /api to drive-sync-service and / to this app.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { sourcemap: false },
});
