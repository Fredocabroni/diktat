import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const base: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_JWT_SECRET: 'jwt',
  UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 't',
};

describe('api loadEnv — empty-string == unset', () => {
  it('a blank TELEGRAM_CHAT_ID is treated as unset, not a regex failure', () => {
    // Without the coercion, TELEGRAM_CHAT_ID='' fails the numeric/@channel regex
    // → boot crash. Coerced to undefined → optional → undefined.
    const env = loadEnv({ ...base, TELEGRAM_CHAT_ID: '', TELEGRAM_BOT_TOKEN: '' });
    expect(env.TELEGRAM_CHAT_ID).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('NODE_ENV="" falls back to the default', () => {
    expect(loadEnv({ ...base, NODE_ENV: '' }).NODE_ENV).toBe('development');
  });

  it('a genuinely-required var that is blank still errors', () => {
    expect(() => loadEnv({ ...base, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL/);
  });

  it('a valid TELEGRAM_CHAT_ID is still honored', () => {
    expect(loadEnv({ ...base, TELEGRAM_CHAT_ID: '-1001234567890' }).TELEGRAM_CHAT_ID).toBe(
      '-1001234567890',
    );
  });
});
