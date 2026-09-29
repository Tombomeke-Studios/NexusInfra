import { defineWorkspace } from 'vitest/config';

// Two test environments in one repo: Node for the backend services/shared, and
// jsdom for the React dashboard (which has its own vitest.config.ts). Root
// `npm test` (vitest run) runs both projects.
//
// `npm run test:integration` sets VITEST_INTEGRATION and runs only the tests
// that need a real broker and database (#242) — kept out of `npm test` so the
// unit suite still needs nothing running.
const integration = defineWorkspace([
  {
    test: {
      name: 'integration',
      include: ['{services,shared}/**/*.integration.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
      hookTimeout: 60_000,
      // One broker, one connection per process, shared queues: in order.
      fileParallelism: false,
    },
  },
]);

const unit = defineWorkspace([
  {
    test: {
      name: 'backend',
      // `deploy` has no source of its own — it holds the release bundles, which
      // are checked against the grammars Docker enforces (#291, #292).
      include: ['{services,shared,deploy,cli}/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
      environment: 'node',
    },
  },
  './dashboard',
]);

export default process.env.VITEST_INTEGRATION ? integration : unit;
