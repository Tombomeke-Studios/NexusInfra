import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dashboard tests run in jsdom with Testing Library. The setup file registers
// the jest-dom matchers and cleans up the DOM between tests.
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'dashboard',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
