import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Broker/event plumbing logs errors and moves on by design.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Build-time scripts run under Node, not in a browser, so `process` and
    // `console` are theirs to use.
    files: ['**/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  }
);
