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

describe('workers loadEnv — HEAT_ENABLED and HEAT_SHADOW_ENABLED are independent flags', () => {
  it('both default to false when unset', () => {
    const env = loadEnv(base);
    expect(env.HEAT_ENABLED).toBe(false);
    expect(env.HEAT_SHADOW_ENABLED).toBe(false);
  });

  it('HEAT_SHADOW_ENABLED=true does NOT flip HEAT_ENABLED', () => {
    const env = loadEnv({ ...base, HEAT_SHADOW_ENABLED: 'true' });
    expect(env.HEAT_SHADOW_ENABLED).toBe(true);
    expect(env.HEAT_ENABLED).toBe(false);
  });

  it('HEAT_ENABLED=true does NOT flip HEAT_SHADOW_ENABLED', () => {
    const env = loadEnv({ ...base, HEAT_ENABLED: 'true' });
    expect(env.HEAT_ENABLED).toBe(true);
    expect(env.HEAT_SHADOW_ENABLED).toBe(false);
  });
});

describe('workers loadEnv — X_TRENDS_ENABLED requires X_BEARER_TOKEN', () => {
  it('X_TRENDS_ENABLED=true with blank X_BEARER_TOKEN hard-fails at parse', () => {
    expect(() => loadEnv({ ...base, X_TRENDS_ENABLED: 'true' })).toThrow(/X_BEARER_TOKEN/);
    expect(() => loadEnv({ ...base, X_TRENDS_ENABLED: 'true', X_BEARER_TOKEN: '' })).toThrow(
      /X_BEARER_TOKEN/,
    );
  });

  it('X_TRENDS_ENABLED=true with non-empty X_BEARER_TOKEN parses cleanly', () => {
    const env = loadEnv({
      ...base,
      X_TRENDS_ENABLED: 'true',
      X_BEARER_TOKEN: 'bearer-abc',
    });
    expect(env.X_TRENDS_ENABLED).toBe(true);
    expect(env.X_BEARER_TOKEN).toBe('bearer-abc');
  });

  it('X_TRENDS_ENABLED=false with blank X_BEARER_TOKEN is still fine (the default shape)', () => {
    const env = loadEnv(base);
    expect(env.X_TRENDS_ENABLED).toBe(false);
    expect(env.X_BEARER_TOKEN).toBe('');
  });
});

describe('workers loadEnv — TELEGRAM_DIGEST_ENABLED authorisation requirements', () => {
  it('enabled with no bot token fails parse', () => {
    expect(() =>
      loadEnv({ ...base, TELEGRAM_DIGEST_ENABLED: 'true', TELEGRAM_CHAT_ID: '123' }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('enabled with no chat id fails parse', () => {
    expect(() =>
      loadEnv({
        ...base,
        TELEGRAM_DIGEST_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      }),
    ).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('enabled with DM chat id (positive numeric) parses cleanly without OPERATOR_USER_ID', () => {
    const env = loadEnv({
      ...base,
      TELEGRAM_DIGEST_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '42',
    });
    expect(env.TELEGRAM_DIGEST_ENABLED).toBe(true);
    expect(env.TELEGRAM_CHAT_ID).toBe('42');
    expect(env.TELEGRAM_OPERATOR_USER_ID).toBe('');
  });

  it('enabled with group chat id (negative supergroup) without OPERATOR_USER_ID fails parse', () => {
    expect(() =>
      loadEnv({
        ...base,
        TELEGRAM_DIGEST_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-1001234567890',
      }),
    ).toThrow(/TELEGRAM_OPERATOR_USER_ID/);
  });

  it('enabled with group chat id + OPERATOR_USER_ID parses cleanly', () => {
    const env = loadEnv({
      ...base,
      TELEGRAM_DIGEST_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_OPERATOR_USER_ID: '99',
    });
    expect(env.TELEGRAM_CHAT_ID).toBe('-1001234567890');
    expect(env.TELEGRAM_OPERATOR_USER_ID).toBe('99');
  });

  it('enabled with non-numeric chat id (channel @slug) without OPERATOR_USER_ID fails parse', () => {
    expect(() =>
      loadEnv({
        ...base,
        TELEGRAM_DIGEST_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '@diktat_ops',
      }),
    ).toThrow(/TELEGRAM_OPERATOR_USER_ID/);
  });

  it('disabled with everything blank is the default-shape', () => {
    const env = loadEnv(base);
    expect(env.TELEGRAM_DIGEST_ENABLED).toBe(false);
    expect(env.TELEGRAM_OPERATOR_USER_ID).toBe('');
  });
});
