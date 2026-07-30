import { describe, expect, it, vi } from 'vitest';

import { clampToTelegram, escapeHtml, makeAlerter, type AlertFailure } from '../alerts.js';

interface Sent {
  url: string;
  body: { chat_id: string; text: string; parse_mode: string };
}

/** A fake fetch that records calls and returns a configurable result. */
function fakeFetch(result: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Sent[] = [];
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return result;
  });
  return { fn, calls };
}

const cfg = (over = {}) => ({
  botToken: 'BOT:secret-token',
  chatId: 'CHAT-123',
  now: () => 1_000_000,
  ...over,
});

describe('escapeHtml', () => {
  it('escapes &, <, > (and only those)', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeHtml('quote " stays')).toBe('quote " stays');
  });
});

describe('clampToTelegram', () => {
  it('leaves short text untouched', () => {
    expect(clampToTelegram('hello')).toBe('hello');
  });
  it('clamps to <= 4096 and never ends on a partial entity', () => {
    const text = 'x'.repeat(4090) + '&amp;&amp;&amp;'; // pushes past 4096 mid-entity
    const out = clampToTelegram(text);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('…')).toBe(true);
    expect(/&[a-z]*$/i.test(out.slice(0, -1))).toBe(false); // no dangling entity before the ellipsis
  });
});

describe('makeAlerter', () => {
  it('disabled (no token/chatId) is a silent no-op', async () => {
    const { fn } = fakeFetch();
    const a = makeAlerter({ fetchImpl: fn, botToken: '', chatId: '' });
    expect(a.enabled).toBe(false);
    await a.alert('error', 'title', 'detail');
    expect(fn).not.toHaveBeenCalled();
  });

  it('HTML-escapes title and detail but keeps our <b> tags', async () => {
    const { fn, calls } = fakeFetch();
    const a = makeAlerter(cfg({ fetchImpl: fn }));
    await a.alert('error', 'a < b & c', 'raw <script> & stuff');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.parse_mode).toBe('HTML');
    expect(calls[0]!.body.text).toBe('🔴 <b>a &lt; b &amp; c</b>\nraw &lt;script&gt; &amp; stuff');
  });

  it('truncates so the payload stays within the Telegram limit', async () => {
    const { fn, calls } = fakeFetch();
    const a = makeAlerter(cfg({ fetchImpl: fn }));
    await a.alert('warn', 'big', 'y'.repeat(10_000));
    expect(calls[0]!.body.text.length).toBeLessThanOrEqual(4096);
  });

  it('dedups the same key within the TTL window (one send)', async () => {
    const { fn } = fakeFetch();
    let t = 1_000_000;
    const a = makeAlerter(cfg({ fetchImpl: fn, now: () => t }));
    await a.alert('error', 't', 'd', { dedupKey: 'k', dedupTtlMs: 1000 });
    t += 500; // within TTL
    await a.alert('error', 't', 'd', { dedupKey: 'k', dedupTtlMs: 1000 });
    expect(fn).toHaveBeenCalledTimes(1);
    t += 600; // TTL elapsed
    await a.alert('error', 't', 'd', { dedupKey: 'k', dedupTtlMs: 1000 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rate-limits within a window and emits a suppression summary on rollover', async () => {
    const { fn, calls } = fakeFetch();
    let t = 1_000_000;
    const a = makeAlerter(
      cfg({ fetchImpl: fn, now: () => t, rateMaxPerWindow: 2, rateWindowMs: 1000 }),
    );
    await a.alert('error', '1', 'd'); // sent
    await a.alert('error', '2', 'd'); // sent
    await a.alert('error', '3', 'd'); // suppressed
    await a.alert('error', '4', 'd'); // suppressed
    expect(fn).toHaveBeenCalledTimes(2);
    t += 1500; // new window -> rollover summary
    await a.alert('error', '5', 'd');
    const texts = calls.map((c) => c.body.text);
    expect(texts.some((x) => x.includes('alerts suppressed') && x.includes('2 alert(s)'))).toBe(
      true,
    );
  });

  it('never throws when fetch rejects, and reports ONLY a reason (no token/url)', async () => {
    const boom = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED https://api.telegram.org/botBOT:secret-token/...');
    });
    const seen: AlertFailure[] = [];
    const a = makeAlerter(
      cfg({ fetchImpl: boom, onFailure: (info: AlertFailure) => seen.push(info) }),
    );
    await expect(a.alert('error', 't', 'd')).resolves.toBeUndefined();
    expect(seen).toEqual([{ status: 'network', severity: 'error' }]);
    // The failure signal carries no token/url — only the coarse reason.
    expect(JSON.stringify(seen)).not.toContain('secret-token');
    expect(JSON.stringify(seen)).not.toContain('api.telegram.org');
  });

  it('reports the HTTP status (only) on a non-ok response', async () => {
    const { fn } = fakeFetch({ ok: false, status: 400 });
    const seen: AlertFailure[] = [];
    const a = makeAlerter(cfg({ fetchImpl: fn, onFailure: (i: AlertFailure) => seen.push(i) }));
    await a.alert('error', 't', 'd');
    expect(seen).toEqual([{ status: 400, severity: 'error' }]);
  });
});
