import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dashboard tests run in jsdom with Testing Library. The setup file registers
// the jest-dom matchers and cleans up the DOM between tests.
export default defineConfig({
  plugins: [react()],
  // Tests exercise the full panel, billing included, so they run as a hosted
  // build. The community build's *exclusion* of that code is verified against
  // the real bundle instead — see `npm run verify:edition` (#190).
  define: {
    __BUILD_EDITION__: JSON.stringify(process.env.NEXUS_EDITION === 'community' ? 'community' : 'hosted'),
  },
  test: {
    name: 'dashboard',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
