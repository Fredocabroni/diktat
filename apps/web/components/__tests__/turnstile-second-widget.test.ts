// Pins the fix for the two-widget race on /login.
//
// Bug: next/script dedupes by `src`. When /login mounts the email-OTP
// widget AND the X-OAuth widget at once (NEXT_PUBLIC_X_OAUTH_ENABLED=true),
// only the first instance's `onReady` fires. The second widget's
// container stays empty, its token stays null, and "Continue with X"
// stays disabled.
//
// Fix (TurnstileWidget.tsx mount effect): if `window.turnstile` isn't
// present at mount, poll every 100ms (cap ~10s) and call renderWidget()
// once it appears. The timer is cleared on unmount AND when the SDK
// resolves. The existing onReady path is kept.
//
// vitest.config.ts scopes the apps/web suite to Node, so this file:
//   1. source-pins the fallback polling (regression guard), and
//   2. exercises the polling LOGIC against a mocked `window` to confirm
//      two mounts both resolve once `window.turnstile` appears.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const WIDGET = readFileSync(new URL('../TurnstileWidget.tsx', import.meta.url), 'utf8');

describe('TurnstileWidget — second-widget race fix (source pins)', () => {
  it('mount effect polls window.turnstile when it is absent at mount', () => {
    // The fallback render path for second instances mounted while the
    // Turnstile SDK is still loading. Without this, next/script's
    // onReady fires only once per page load and the second widget
    // never renders.
    expect(WIDGET).toMatch(/setInterval\(/);
    expect(WIDGET).toMatch(/window\.turnstile/);
  });

  it('polls at ~100ms and caps at ~10s so a wedged load never spins forever', () => {
    // 100ms interval + 10s cap: ≤100 ticks before giving up. Covers
    // the real network tail without becoming a leak if Cloudflare
    // never serves the SDK.
    expect(WIDGET).toMatch(/,\s*100\)/);
    expect(WIDGET).toMatch(/10_000|10000/);
  });

  it('clears the interval on unmount (strict-mode double-mount safety)', () => {
    // The cleanup function must clearInterval before the mount effect
    // ever stashes it in a ref; otherwise a dev re-mount leaks the
    // timer and double-renders the widget.
    expect(WIDGET).toMatch(/return\s*\(\)\s*=>\s*\{[\s\S]*clearInterval\(pollId\)/);
  });

  it('clears the interval the moment the SDK appears (no post-render polling)', () => {
    // Once renderWidget() succeeds, the interval must stop — otherwise
    // the next tick calls renderWidget() again (idempotent via the
    // widgetIdRef guard, but still wasted work).
    const effectBlock = WIDGET.slice(
      WIDGET.indexOf('useEffect(() => {'),
      WIDGET.indexOf('}, [renderWidget]);'),
    );
    expect(effectBlock).toMatch(/renderWidget\(\);[\s\S]{0,200}clearInterval\(pollId\)/);
  });

  it('keeps the existing onReady path alongside the polling fallback', () => {
    // The onReady callback is still the fast-path for the FIRST
    // widget. Polling is only the fallback for later mounts.
    expect(WIDGET).toMatch(/onReady=\{\(\)\s*=>\s*\{[\s\S]{0,200}renderWidget\(\)/);
  });
});

describe('TurnstileWidget — two-mount race simulation', () => {
  // Confirms the structural guarantee: given two mounts that both see
  // `window.turnstile === undefined` at effect-run time, once the
  // Turnstile SDK attaches, BOTH mounts call `render()` exactly once.
  // Simulates the polling pattern used in the mount effect against a
  // mocked `window`; no React, no JSX — the shape of the loop is what
  // the fix hinges on.

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error cleanup
    delete globalThis.window;
  });

  function mountWithPolling(renderWidget: () => void): () => void {
    const started = Date.now();
    const w = globalThis.window as { turnstile?: unknown };
    let pollId: ReturnType<typeof setInterval> | null = null;
    if (w.turnstile) {
      renderWidget();
    } else {
      pollId = setInterval(() => {
        if (w.turnstile) {
          renderWidget();
          if (pollId !== null) {
            clearInterval(pollId);
            pollId = null;
          }
        } else if (Date.now() - started > 10_000) {
          if (pollId !== null) {
            clearInterval(pollId);
            pollId = null;
          }
        }
      }, 100);
    }
    return () => {
      if (pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
    };
  }

  it('both widgets render exactly once when window.turnstile appears after mount', () => {
    vi.useFakeTimers();
    // @ts-expect-error partial window shim
    globalThis.window = {};

    const render1 = vi.fn();
    const render2 = vi.fn();

    const unmount1 = mountWithPolling(render1);
    const unmount2 = mountWithPolling(render2);

    // Advance past a few poll ticks — SDK still missing — neither
    // widget renders.
    vi.advanceTimersByTime(500);
    expect(render1).not.toHaveBeenCalled();
    expect(render2).not.toHaveBeenCalled();

    // Cloudflare serves the SDK; both widgets should pick it up on
    // the next tick.
    (globalThis.window as { turnstile?: unknown }).turnstile = {};
    vi.advanceTimersByTime(200);

    expect(render1).toHaveBeenCalledTimes(1);
    expect(render2).toHaveBeenCalledTimes(1);

    unmount1();
    unmount2();
  });

  it('stops polling after the 10s cap without the SDK ever appearing', () => {
    vi.useFakeTimers();
    // @ts-expect-error partial window shim
    globalThis.window = {};

    const renderFn = vi.fn();
    const unmount = mountWithPolling(renderFn);

    // 11 seconds — well past the cap — SDK never appears.
    vi.advanceTimersByTime(11_000);

    // Should NOT have attempted to render.
    expect(renderFn).not.toHaveBeenCalled();

    // And a late SDK arrival after the cap must not resurrect the
    // poller.
    (globalThis.window as { turnstile?: unknown }).turnstile = {};
    vi.advanceTimersByTime(1_000);
    expect(renderFn).not.toHaveBeenCalled();

    unmount();
  });

  it('unmount before the SDK arrives cancels the polling loop', () => {
    vi.useFakeTimers();
    // @ts-expect-error partial window shim
    globalThis.window = {};

    const renderFn = vi.fn();
    const unmount = mountWithPolling(renderFn);

    // Component unmounts quickly.
    vi.advanceTimersByTime(200);
    unmount();

    // SDK arrives later — the cancelled poller must not fire.
    (globalThis.window as { turnstile?: unknown }).turnstile = {};
    vi.advanceTimersByTime(1_000);
    expect(renderFn).not.toHaveBeenCalled();
  });
});
