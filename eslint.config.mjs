// Flat ESLint config (ESLint v9+). Phase 0 baseline — minimal rules.
// Per-package overrides go in apps/web/eslint.config.mjs etc.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.claude/state/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // PR #62 round-3 leftover #3 — enforce the `rate-limit.internal.ts`
  // import boundary. Production code MUST go through the public
  // middleware factories in `apps/api/src/rate-limit.ts` (the barrel);
  // the `.internal.ts` file is implementation detail (Lua scripts,
  // key builders, window sizes). Header comment in rate-limit.ts
  // already says so, but the previous gate was convention only —
  // TypeScript's module system enforced nothing. This rule fires at
  // lint time if any non-test source file under `apps/api/src/**`
  // imports from `*rate-limit.internal*`, EXCEPT the barrel itself.
  //
  // Allowed: `apps/api/src/rate-limit.ts` (the barrel),
  //          `apps/api/__tests__/**` (test fixtures need the internals
  //                                    to exercise window sizes, Lua
  //                                    return-shape testing, etc.),
  //          `apps/api/scripts/**`   (probe + validation scripts).
  // Forbidden everywhere else.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/rate-limit.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/rate-limit.internal*', '**/rate-limit.internal.js'],
              message:
                'Import from `./rate-limit.js` (the public barrel), not the .internal.ts file. The internal module is implementation detail — production code MUST chain through the middleware factories. PR #62 round-3 leftover #3.',
            },
          ],
        },
      ],
    },
  },
);
