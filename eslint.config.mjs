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

  // Production-import boundaries for apps/api/src/**. Both rules use
  // `no-restricted-imports`; flat config does NOT merge rule definitions
  // across multiple config blocks for overlapping file globs (last-wins
  // per rule-id), so the two boundaries MUST live in one block with a
  // single rule definition and a `patterns` array carrying both entries.
  // The `ignores` list combines both rules' defining-file carve-outs:
  // `apps/api/src/rate-limit.ts` (barrel for the .internal.ts boundary)
  // and `apps/api/src/context.ts` (the file that exports
  // resetRedisCache). Both files are exempt from BOTH rules, which is
  // safe because neither imports the other's restricted target.
  //
  // Test files under `apps/api/__tests__/**` and scripts under
  // `apps/api/scripts/**` are outside the `files` glob — their carve-out
  // is automatic.
  //
  // ─── Pattern 1: .internal.ts boundary (PR #62 round-3 leftover #3) ───
  //
  // Production code MUST go through the public middleware factories in
  // `apps/api/src/rate-limit.ts` (the barrel); the `.internal.ts` file
  // is implementation detail (Lua scripts, key builders, window sizes).
  // Header comment in rate-limit.ts already says so, but the previous
  // gate was convention only — TypeScript's module system enforced
  // nothing. Path-shape filter — any import string matching
  // `**/rate-limit.internal*` fails.
  //
  // ─── Pattern 2: resetRedisCache named-import boundary (PR #62 leftover #4) ───
  //
  // `resetRedisCache` is a test-only escape hatch that nulls the
  // module-level Redis singleton; a production call orphans the Upstash
  // client reference held by server.ts's outer hook (the singleton
  // exists for exact-once boot construction). Unlike the .internal.ts
  // boundary this is a NAMED-import rule: every OTHER export from
  // `context` (getOrBuildRedis, Context, normalizeIpToCidr, …) is
  // legitimate everywhere — only `resetRedisCache` is restricted.
  // The sole allowed caller is test teardown under
  // `apps/api/__tests__/**`, which lies outside the `apps/api/src/**`
  // files glob below, so the carve-out is automatic.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/rate-limit.ts', 'apps/api/src/context.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Pattern 1: .internal.ts path-shape boundary.
              group: ['**/rate-limit.internal*', '**/rate-limit.internal.js'],
              message:
                'Import from `./rate-limit.js` (the public barrel), not the .internal.ts file. The internal module is implementation detail — production code MUST chain through the middleware factories. PR #62 round-3 leftover #3.',
            },
            {
              // Pattern 2: resetRedisCache named-import boundary.
              group: ['**/context', '**/context.js', '**/context.ts'],
              importNames: ['resetRedisCache'],
              message:
                '`resetRedisCache` is a test-only escape hatch — production code MUST NOT import it. Calling it nulls the Redis singleton and orphans the Upstash client held by server.ts. Use it only in test teardown under apps/api/__tests__/**. PR #62 round-3 leftover #4.',
            },
          ],
        },
      ],
    },
  },
);
