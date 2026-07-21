import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard dev server on 5173; proxy /api to the Orchestrator (:9200) so the
// browser talks to a same-origin path in dev without CORS surprises. The API
// client (later unit) targets a configurable base that defaults to /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.ORCHESTRATOR_URL || 'http://localhost:9200',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
