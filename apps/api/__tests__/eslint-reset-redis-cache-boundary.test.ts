import path from 'node:path';
import url from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// PR #62 round-3 leftover #4 — `resetRedisCache` named-import boundary.
//
// `apps/api/src/context.ts` exports `resetRedisCache(): void` as a
// test-only escape hatch (nulls the module-level Redis singleton so
// the next `getOrBuildRedis(env)` call reconstructs from scratch). A
// production call would orphan the Upstash client reference held by
// server.ts's outer hook. The function carries a JSDoc warning to that
// effect, but the previous gate was convention only — nothing enforced
// it at lint time.
//
// The `no-restricted-imports` rule in eslint.config.mjs now fires at
// lint time on any production import of `resetRedisCache` from
// `apps/api/src/**` (excluding the defining file itself). Crucially,
// the rule targets the NAMED IMPORT — every OTHER export from `context`
// (`getOrBuildRedis`, `Context`, `normalizeIpToCidr`, etc.) is
// legitimate everywhere and must continue to lint clean.
//
// This test pins BOTH directions of the rule programmatically — it
// loads the actual flat config and runs ESLint against synthetic
// source code at controlled file paths. If a future config tweak
// accidentally widens the exception list, drops the rule entirely, or
// over-broadens it to clobber sibling exports, this test catches the
// regression. Mirrors the eslint-internal-import-boundary.test.ts
// shape (same programmatic harness, same RED/GREEN/control split).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');

async function lintAs(filePath: string, source: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  return eslint.lintText(source, { filePath });
}

// Discriminator keys on `/resetRedisCache/i` in the message — NOT just
// `ruleId === 'no-restricted-imports'`. The .internal.ts boundary uses
// the same rule-id; without the message-content discriminator the two
// boundary tests would conflate any time both fire on the same source.
function hasRestrictedImportError(results: ESLint.LintResult[]): boolean {
  return results.some((r) =>
    r.messages.some(
      (m) => m.ruleId === 'no-restricted-imports' && /resetRedisCache/i.test(m.message),
    ),
  );
}

// Three relative-path shapes a production src file might write. Each
// targets the same `context` module from a different depth; the rule's
// `**/context{,.js,.ts}` group must catch all three.
const BAD_IMPORT_SHAPES = [
  `import { resetRedisCache } from '../context.js';`, // routers/ → src/
  `import { resetRedisCache } from './context.js';`, // src/ sibling
  `import { resetRedisCache } from '../../context.js';`, // routers/<deeper>/ → src/
];

// Legitimate sibling-export import; MUST continue to lint clean. If the
// rule accidentally widens to all imports from `**/context*`, this fails.
const GOOD_SIBLING_IMPORT = `import { getOrBuildRedis } from '../context.js';`;

describe('ESLint no-restricted-imports — resetRedisCache boundary', () => {
  // ---------- RED DIRECTION ----------
  // Production src file under apps/api/src/ that's NOT the defining
  // file must trip the rule on every relative-path shape of the import.

  for (const importLine of BAD_IMPORT_SHAPES) {
    it(`RED: forbids ${importLine.slice(0, 70)}... from a production src file`, async () => {
      const results = await lintAs(
        path.resolve(REPO_ROOT, 'apps/api/src/routers/wallet.ts'),
        `${importLine}\nexport const _ = resetRedisCache;\n`,
      );
      expect(hasRestrictedImportError(results)).toBe(true);
    });
  }

  // ---------- GREEN DIRECTION — TEST CARVE-OUT ----------
  // The real legitimate caller is the dedicated test-teardown file
  // `apps/api/__tests__/redis-cache-reset.test.ts`. Test files live
  // OUTSIDE the rule's `files: ['apps/api/src/**/*.ts']` glob, so the
  // carve-out is automatic — but assert it explicitly so a future
  // config tweak that re-broadens the `files` glob doesn't silently
  // break the only existing caller.

  it('GREEN: allows the legit test-teardown caller under `apps/api/__tests__/**`', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/__tests__/redis-cache-reset.test.ts'),
      `import { getOrBuildRedis, resetRedisCache } from '../src/context.js';\nexport const _ = resetRedisCache ?? getOrBuildRedis;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });

  // ---------- GREEN DIRECTION — SURGICAL ----------
  // The rule MUST target only the named import `resetRedisCache`. A
  // production src file importing ANY OTHER named export from `context`
  // must continue to lint clean — confirms the rule isn't a blunt
  // path-shape ban that breaks legitimate `getOrBuildRedis` / `Context`
  // / `normalizeIpToCidr` / `buildContext` callers.

  it('GREEN: does not flag the legit sibling import `getOrBuildRedis` from a router', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/src/routers/wallet.ts'),
      `${GOOD_SIBLING_IMPORT}\nexport const _ = getOrBuildRedis;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });

  // ---------- GREEN DIRECTION — DEFINING FILE ----------
  // The defining file `apps/api/src/context.ts` is in the rule's
  // `ignores` list. A self-import wouldn't make sense, but the rule's
  // `files`/`ignores` scoping is the gate: confirm `context.ts` itself
  // never matches the rule even with the import shape present.

  it('GREEN: allows the defining file `apps/api/src/context.ts` (ignored by config)', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/src/context.ts'),
      `import { resetRedisCache } from './context.js';\nexport const _ = resetRedisCache;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });
});
