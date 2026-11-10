// Source-level pins for the Open Debate flag-gate. vitest-node; no
// rendering. Asserts the structural invariants that the end-to-end
// behaviour (nav hidden, routes redirect) depends on, under both the
// `NEXT_PUBLIC_OPEN_DEBATE_ENABLED !== 'true'` and the opt-in paths.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

const FLAGS = readFileSync(new URL('../../lib/flags.ts', import.meta.url), 'utf8');
const LAYOUT = readFileSync(new URL('../(app)/layout.tsx', import.meta.url), 'utf8');
const BATTLES = readFileSync(new URL('../(app)/battles/page.tsx', import.meta.url), 'utf8');
const BATTLE_BY_ID = readFileSync(
  new URL('../(app)/battles/[id]/page.tsx', import.meta.url),
  'utf8',
);
const OD_ENTRY = readFileSync(
  new URL('../(app)/play/open-debate/page.tsx', import.meta.url),
  'utf8',
);

describe('isOpenDebateEnabled — flag semantics', () => {
  const originalEnv = process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED;
  afterEach(() => {
    process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED = originalEnv;
  });

  it('strict equality on the string literal "true" — nothing else turns the flag on', async () => {
    // Pin the source so a future edit can't widen the predicate to
    // truthy/includes/toLowerCase (which would flip the flag on for
    // 'TRUE', '1', 'yes').
    expect(FLAGS).toMatch(/process\.env\.NEXT_PUBLIC_OPEN_DEBATE_ENABLED\s*===\s*'true'/);
    // Runtime check too.
    const mod = await import('../../lib/flags');
    for (const v of ['false', '0', '', 'TRUE', 'yes', '1', undefined] as const) {
      if (v === undefined) delete process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED;
      else process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED = v;
      expect(mod.isOpenDebateEnabled(), `env=${String(v)}`).toBe(false);
    }
    process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED = 'true';
    expect(mod.isOpenDebateEnabled()).toBe(true);
  });
});

describe('Battles nav tab — flag-gated in (app) layout', () => {
  it('Battles tab lives in a dedicated BATTLES_TAB const (not inlined in BASE_TABS)', () => {
    const baseTabsBlock = LAYOUT.match(/const BASE_TABS = \[[\s\S]*?\] as const;/);
    expect(baseTabsBlock).not.toBeNull();
    expect(baseTabsBlock![0]!).toMatch(/href: '\/'/);
    expect(baseTabsBlock![0]!).toMatch(/href: '\/wallet'/);
    expect(baseTabsBlock![0]!).toMatch(/href: '\/profile'/);
    // Hard negative: BASE_TABS must not list the Battles tab.
    expect(baseTabsBlock![0]!).not.toMatch(/href: '\/battles'/);
    expect(LAYOUT).toMatch(/BATTLES_TAB\s*=\s*\{\s*href:\s*'\/battles'/);
  });

  it('tabs list splices BATTLES_TAB into Home → Battles → Wallet → Profile only when the flag is on', () => {
    expect(LAYOUT).toMatch(
      /isOpenDebateEnabled\(\)\s*\?\s*\[\s*BASE_TABS\[0\],\s*BATTLES_TAB,\s*\.\.\.BASE_TABS\.slice\(1\)\s*\]\s*:\s*BASE_TABS/,
    );
    expect(LAYOUT).toMatch(/tabs\.map\(/);
    expect(LAYOUT).not.toMatch(/TABS\.map\(/);
  });

  it('imports the flag helper from the shared lib', () => {
    expect(LAYOUT).toMatch(/from '\.\.\/\.\.\/lib\/flags'/);
  });
});

describe('/battles route — redirects to / when flag is off', () => {
  it('top of handler calls redirect("/") under !isOpenDebateEnabled()', () => {
    expect(BATTLES).toMatch(/if \(!isOpenDebateEnabled\(\)\) redirect\('\/'\)/);
    expect(BATTLES).toMatch(/import \{ redirect \} from 'next\/navigation'/);
    // Original Link code stays — the route is kept, not deleted.
    expect(BATTLES).toMatch(/<Link/);
  });
});

describe('/battles/[id] route — redirects to / when flag is off', () => {
  it('top of handler calls redirect("/") before any DB read', () => {
    // The redirect must happen BEFORE the params / auth / battle
    // lookup — otherwise a disabled surface still hits the DB.
    const handler = BATTLE_BY_ID.match(
      /export default async function BattleByIdPage[\s\S]*?\{([\s\S]*?)\n\}/,
    );
    expect(handler).not.toBeNull();
    const body = handler![1]!;
    const redirectIdx = body.indexOf('redirect(');
    const paramsIdx = body.indexOf('await params');
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(paramsIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeLessThan(paramsIdx);
    expect(BATTLE_BY_ID).toMatch(/if \(!isOpenDebateEnabled\(\)\) redirect\('\/'\)/);
  });
});

describe('/play/open-debate route — redirects to / when flag is off', () => {
  it('top of handler calls redirect("/") before the topics query', () => {
    const handler = OD_ENTRY.match(
      /export default async function OpenDebateEntryPage[\s\S]*?\{([\s\S]*?)\n\}/,
    );
    expect(handler).not.toBeNull();
    const body = handler![1]!;
    const redirectIdx = body.indexOf('redirect(');
    const supabaseIdx = body.indexOf('getServerSupabaseClient');
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(supabaseIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeLessThan(supabaseIdx);
    expect(OD_ENTRY).toMatch(/if \(!isOpenDebateEnabled\(\)\) redirect\('\/'\)/);
  });
});
