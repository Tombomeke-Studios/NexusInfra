import { defineWorkspace } from 'vitest/config';

// Two test environments in one repo: Node for the backend services/shared, and
// jsdom for the React dashboard (which has its own vitest.config.ts). Root
// `npm test` (vitest run) runs both projects.
export default defineWorkspace([
  {
    test: {
      name: 'backend',
      // `deploy` has no source of its own — it holds the release bundles, which
      // are checked against the grammars Docker enforces (#291, #292).
      include: ['{services,shared,deploy}/**/*.test.ts'],
      environment: 'node',
    },
  },
  './dashboard',
]);
