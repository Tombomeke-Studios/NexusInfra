import { defineWorkspace } from 'vitest/config';

// Two test environments in one repo: Node for the backend services/shared, and
// jsdom for the React dashboard (which has its own vitest.config.ts). Root
// `npm test` (vitest run) runs both projects.
export default defineWorkspace([
  {
    test: {
      name: 'backend',
      include: ['{services,shared}/**/*.test.ts'],
      environment: 'node',
    },
  },
  './dashboard',
]);
