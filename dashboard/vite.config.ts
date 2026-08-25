import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Dashboard dev server on 5173; proxy /api to the Orchestrator (:9200) so the
// browser talks to a same-origin path in dev without CORS surprises. The API
// client targets a configurable base that defaults to /api.
//
// The build is **per edition** (#190). The community bundle must not merely hide
// the billing UI — it must not contain it, because this code is served to a
// browser and the community edition can never use it. Two things make that true:
//
//   1. `__BUILD_EDITION__` becomes a literal, so the billing route is statically
//      unreachable and the bundler drops it.
//   2. The billing page is aliased to a stub, so the real module never enters
//      the module graph at all.
//
// Verified rather than assumed — `npm run verify:edition` greps the built bundle.
const edition = process.env.NEXUS_EDITION === 'hosted' ? 'hosted' : 'community';

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_EDITION__: JSON.stringify(edition),
  },
  resolve: {
    alias:
      edition === 'hosted'
        ? []
        : [{ find: fromHere('./src/pages/Billing.tsx'), replacement: fromHere('./src/pages/Billing.stub.tsx') }],
  },
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
