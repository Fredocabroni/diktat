import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

// Minimal valid required set (the 5 boot-critical vars).
const base: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 't',
};

describe('workers loadEnv — empty-string == unset', () => {
  it('NODE_ENV="" falls back to the default instead of hard-failing the enum', () => {
    // This is the exact production crash: railway.toml [env] NODE_ENV=production
    // arrived as '' → Invalid enum value at boot.
    expect(loadEnv({ ...base, NODE_ENV: '' }).NODE_ENV).toBe('development');
  });

  it('a real NODE_ENV value is honored', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('a blank optional var ("") is treated as unset (no default coercion needed)', () => {
    expect(loadEnv({ ...base, TELEGRAM_BOT_TOKEN: '' }).TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(loadEnv({ ...base, PRIVY_APP_ID: '' }).PRIVY_APP_ID).toBe(''); // has its own '' default
  });

  it('a genuinely-required var that is blank still errors as Required', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
