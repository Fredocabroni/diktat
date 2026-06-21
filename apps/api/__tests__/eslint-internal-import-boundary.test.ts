import path from 'node:path';
import url from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// PR #62 round-3 leftover #3 — `.internal.ts` import boundary.
//
// `apps/api/src/rate-limit.internal.ts` holds the Lua scripts, key
// builders, and window-size constants for the rate-limit middleware.
// Header comment says "Production code MUST NOT import from this file
// — only the middleware factories defined in rate-limit.ts should."
// Before this PR that gate was convention only; TypeScript's module
// system enforced nothing. The `no-restricted-imports` rule in the
// repo's flat ESLint config now fires at lint time on violation.
//
// This test pins BOTH directions of the rule programmatically — it
// loads the actual flat config and runs ESLint against synthetic
// source code at controlled file paths. If a future config tweak
// accidentally widens the exception list or drops the rule entirely,
// the bad-import direction stops failing and this test catches it.
//
// File paths are passed as `filePath` to `lintText` so the rule's
// `files` / `ignores` scoping kicks in. The synthetic source never
// touches disk.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');

async function lintAs(filePath: string, source: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  return eslint.lintText(source, { filePath });
}

function hasRestrictedImportError(results: ESLint.LintResult[]): boolean {
  return results.some((r) =>
    r.messages.some(
      (m) => m.ruleId === 'no-restricted-imports' && /rate-limit\.internal/i.test(m.message),
    ),
  );
}

// Three import shapes a tRPC router or other src file might write.
// Each is forbidden when imported from a non-barrel, non-test, non-script
// location under `apps/api/src/**`.
const BAD_IMPORT_SHAPES = [
  `import { SINGLE_GATE_LUA } from './rate-limit.internal.js';`,
  `import { COMBINED_ATOMIC_LUA } from '../rate-limit.internal.js';`,
  `import * as internals from '../rate-limit.internal';`,
];

// Allowed import shape that goes through the public barrel.
const GOOD_BARREL_IMPORT = `import { aiSpendLimit, mutationLimit } from '../rate-limit.js';`;

describe('ESLint no-restricted-imports — rate-limit.internal boundary', () => {
  // ---------- RED DIRECTION ----------
  // A non-test source file under apps/api/src/ that's NOT the barrel
  // must trip the rule on every shape of the forbidden import.

  for (const importLine of BAD_IMPORT_SHAPES) {
    it(`RED: forbids ${importLine.slice(0, 60)}... from a non-barrel src file`, async () => {
      const results = await lintAs(
        path.resolve(REPO_ROOT, 'apps/api/src/routers/wallet.ts'),
        `${importLine}\nexport const _ = SINGLE_GATE_LUA ?? COMBINED_ATOMIC_LUA ?? internals;\n`,
      );
      expect(hasRestrictedImportError(results)).toBe(true);
    });
  }

  // ---------- GREEN DIRECTION — EXCEPTIONS ----------
  // Three carve-outs: the barrel, tests, scripts. Each must NOT trip
  // the rule when importing the internals — otherwise the rule is
  // over-broad and breaks the existing in-repo callers.

  it('GREEN: allows the barrel `apps/api/src/rate-limit.ts` to import the internals', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/src/rate-limit.ts'),
      `import { SINGLE_GATE_LUA } from './rate-limit.internal.js';\nexport const _ = SINGLE_GATE_LUA;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });

  it('GREEN: allows test files under `apps/api/__tests__/**` to import the internals', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/__tests__/rate-limit.test.ts'),
      `import { SINGLE_GATE_LUA } from '../src/rate-limit.internal.js';\nexport const _ = SINGLE_GATE_LUA;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });

  it('GREEN: allows script files under `apps/api/scripts/**` to import the internals', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/scripts/probe-m5-rate-limit-runtime.ts'),
      `import { SINGLE_GATE_LUA } from '../src/rate-limit.internal.js';\nexport const _ = SINGLE_GATE_LUA;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });

  // ---------- GREEN DIRECTION — CONTROL ----------
  // The forbidden import is specific; non-internal imports from src
  // files must continue to lint clean.

  it('GREEN: does not flag the public-barrel import from a router', async () => {
    const results = await lintAs(
      path.resolve(REPO_ROOT, 'apps/api/src/routers/wallet.ts'),
      `${GOOD_BARREL_IMPORT}\nexport const _ = aiSpendLimit ?? mutationLimit;\n`,
    );
    expect(hasRestrictedImportError(results)).toBe(false);
  });
});
