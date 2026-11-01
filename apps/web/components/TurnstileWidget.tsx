// Cloudflare Turnstile widget for the /login page.
//
// Loads the Turnstile script lazily (first mount only) and renders a
// managed instance via the explicit JS API. The widget calls back with
// a token on success; the parent (/login) threads the token into
// `supabase.auth.signInWithOtp` and `verifyOtp` via
// `options.captchaToken`.
//
// Operator deploy order (per PR description):
//   1. Web ships WITHOUT the env var set → `clientEnv.TURNSTILE_SITE_KEY === ''`
//      → the parent conditionally skips mounting this component and
//      omits `captchaToken` from the Supabase call. Pre-launch
//      behaviour is byte-identical.
//   2. Operator sets `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + enables CAPTCHA
//      in the Supabase dashboard. The next deploy picks it up and the
//      widget renders.
//
// Expired-token handling: Turnstile tokens expire after ~5 minutes.
// `expired-callback` nulls the token on the parent, which disables the
// send/verify button; the widget auto-shows a refresh affordance.
//
// `error-callback` surfaces network / challenge failures. The parent
// shows a user-visible retry message; the widget's own retry UI handles
// the actual re-challenge.
//
// Accessibility: Turnstile's managed widget sets `role="group"` and
// uses `aria-live` for state changes. We wrap it in a labelled region
// so screen readers can locate the challenge without seeing the raw
// iframe title.

'use client';

import Script from 'next/script';
import { useCallback, useEffect, useId, useRef } from 'react';

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** Minimal typing for the Cloudflare Turnstile JS SDK the script
 *  injects onto `window.turnstile`. We only use the explicit-render
 *  surface. See https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/ */
interface TurnstileGlobal {
  render(
    container: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
      size?: 'normal' | 'flexible' | 'compact';
      appearance?: 'always' | 'execute' | 'interaction-only';
      retry?: 'auto' | 'never';
      action?: string;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

export interface TurnstileWidgetProps {
  readonly siteKey: string;
  /** Called with the successful challenge token. */
  readonly onToken: (token: string) => void;
  /** Called when the token expires (~5 min TTL) OR a challenge error
   *  occurs. Parent should null its stored token to re-gate the
   *  submit button. */
  readonly onExpired?: () => void;
  readonly onError?: () => void;
  /** Optional action tag — passed through to Turnstile for its own
   *  analytics / rule filtering. */
  readonly action?: string;
}

export function TurnstileWidget(props: TurnstileWidgetProps): React.JSX.Element {
  const { siteKey, onToken, onExpired, onError, action } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const scriptReadyRef = useRef(false);
  const regionId = useId();

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile) return;
    if (widgetIdRef.current !== null) return; // already rendered
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: onToken,
      'expired-callback': () => {
        // Turnstile shows a "Verify again" button inside the widget
        // itself; our parent just needs to know the token is dead.
        onExpired?.();
      },
      'error-callback': () => {
        onError?.();
      },
      // Theme=auto respects the user's `prefers-color-scheme`. The
      // widget self-contrasts with its container.
      theme: 'auto',
      // Mobile-friendly default — Turnstile's `flexible` size scales
      // to the parent container (never overflows a 320px viewport).
      size: 'flexible',
      // Auto-retry on challenge failure keeps the UX recoverable
      // without parent intervention.
      retry: 'auto',
      ...(action ? { action } : {}),
    });
  }, [siteKey, onToken, onExpired, onError, action]);

  useEffect(() => {
    // next/script dedupes by src: when two <TurnstileWidget>s mount
    // at once (email OTP + X OAuth on /login), only the first
    // instance's onReady fires. The second instance must poll for
    // window.turnstile and render itself once the SDK is present.
    // Cap at ~10s so a wedged load doesn't poll forever.
    let pollId: ReturnType<typeof setInterval> | null = null;
    if (window.turnstile) {
      scriptReadyRef.current = true;
      renderWidget();
    } else {
      const started = Date.now();
      pollId = setInterval(() => {
        if (window.turnstile) {
          scriptReadyRef.current = true;
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
      // Clean up the widget on unmount so React 18 Strict-Mode double-
      // mount in dev doesn't leave a zombie iframe.
      if (widgetIdRef.current !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* widget may already be gone; ignore */
        }
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget]);

  return (
    <div
      role="group"
      aria-labelledby={regionId}
      data-component="TurnstileWidget"
      className="flex flex-col gap-2"
    >
      <span id={regionId} className="sr-only">
        Verify you&rsquo;re human
      </span>
      <div ref={containerRef} />
      {/* The Script tag is a no-op if a previous mount already
          injected the SDK (Next ensures one load). next/script
          dedupes by src and only the first instance's onReady fires
          when a second widget mounts while the script is still
          loading; the mount effect above polls window.turnstile as
          the fallback render path. */}
      <Script
        src={TURNSTILE_SCRIPT_SRC}
        strategy="afterInteractive"
        onReady={() => {
          scriptReadyRef.current = true;
          renderWidget();
        }}
      />
    </div>
  );
}
