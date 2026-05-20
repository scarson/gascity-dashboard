import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Single-port deploy: dev server proxies /api → backend at 8081, prod
// build is served by the backend's express.static. The frontend NEVER
// needs to know about cross-origin — everything is same-origin both in
// dev and prod, which keeps the Host-allowlist + Origin check + CSP
// simple.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        // Rewrite Origin to the backend's host:port so write requests
        // pass the backend's originCheck allow-list. Without this,
        // POST/PATCH/DELETE come from http://127.0.0.1:5174 (Vite's
        // origin) and fail with 403 against the backend's allow-list
        // of {127.0.0.1, localhost} × :8081.
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
});
