// Notifications settings. Three states the toggle reflects, in order of
// what the user needs to do next:
//   - browser-level blocked → instruct, do not nag
//   - feature unsupported / no VAPID configured → explain, disabled control
//   - no active subscription → "Enable" call-to-action
//   - active subscription + pref ON  → "On" toggle (turn off = pref=false)
//   - active subscription + pref OFF → "Off" toggle (turn on = pref=true)
//
// We separate the SUBSCRIPTION (a fact about the browser) from the
// PREFERENCE (a user opt-out). Turning the toggle off in the UI flips the
// preference; it does NOT unsubscribe the browser, so re-enabling later
// does not re-prompt for permission. The user can remove the device
// entirely via "Remove this device" — that path hard-deletes the
// subscription row.
//
// All user-facing copy in this file gets reviewed by the copy-linter
// subagent — keep it consistent with the §12 trust test and the
// X_LAUNCH_PLAN voice guide.

'use client';

import { useEffect, useState } from 'react';

import {
  disablePush,
  enablePush,
  getActiveSubscription,
  getPermissionState,
  probeSupport,
  serializeSubscription,
  type PushSupportStatus,
} from '../../../../lib/push';
import { trpc } from '../../../../lib/trpc';

type ToggleState =
  | { kind: 'loading' }
  | { kind: 'unsupported'; reason: PushSupportStatus }
  | { kind: 'permission_denied' }
  | { kind: 'idle' } // supported, permission default/granted, no active sub
  | { kind: 'enabled'; prefOn: boolean };

export default function NotificationsSettingsPage() {
  const [state, setState] = useState<ToggleState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const me = trpc.user.me.useQuery();
  const utils = trpc.useUtils();
  const registerSub = trpc.pushSubscriptions.register.useMutation();
  const unregisterSub = trpc.pushSubscriptions.unregister.useMutation();
  const updatePrefs = trpc.user.updateNotificationPreferences.useMutation();

  // Initial state probe. Runs once on mount; we don't need a watcher because
  // permission and subscription state only change in response to actions we
  // initiate from this page.
  useEffect(() => {
    void (async () => {
      const support = probeSupport();
      if (support !== 'supported') {
        setState({ kind: 'unsupported', reason: support });
        return;
      }
      const permission = getPermissionState();
      if (permission === 'denied') {
        setState({ kind: 'permission_denied' });
        return;
      }
      const sub = await getActiveSubscription();
      if (!sub) {
        setState({ kind: 'idle' });
        return;
      }
      // Read the preference from the loaded profile. Default-on: any value
      // other than explicit `false` is treated as enabled.
      const prefs = (me.data?.notification_preferences ?? {}) as Record<string, unknown>;
      const prefOn = prefs.streak_risk_push !== false;
      setState({ kind: 'enabled', prefOn });
    })();
  }, [me.data?.notification_preferences]);

  async function handleEnable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const sub = await enablePush();
      if (!sub) {
        // User dismissed the permission prompt.
        const perm = getPermissionState();
        if (perm === 'denied') setState({ kind: 'permission_denied' });
        return;
      }
      const serialized = serializeSubscription(sub);
      await registerSub.mutateAsync(serialized);
      // Ensure the preference reflects "on" (default-on, but be explicit so
      // a user who previously turned it off doesn't get a surprising state).
      await updatePrefs.mutateAsync({ streakRiskPush: true });
      await utils.user.me.invalidate();
      setState({ kind: 'enabled', prefOn: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePref(nextOn: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updatePrefs.mutateAsync({ streakRiskPush: nextOn });
      await utils.user.me.invalidate();
      setState((prev) => (prev.kind === 'enabled' ? { ...prev, prefOn: nextOn } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveDevice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const endpoint = await disablePush();
      if (endpoint) {
        await unregisterSub.mutateAsync({ endpoint });
      }
      setState({ kind: 'idle' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-md px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-text-primary">Notifications</h1>
      <p className="mt-2 text-sm text-text-secondary">
        We push at most once a day, at 9 PM local, only when your streak is on the line.
      </p>

      <div className="mt-8 rounded-2xl border border-ink-300 bg-surface-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-text-primary">
              Streak reminders
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Quiet, once a day at 9 PM if your streak is still going.
            </p>
          </div>

          <ToggleControl
            state={state}
            busy={busy}
            onEnable={handleEnable}
            onTogglePref={handleTogglePref}
          />
        </div>

        {state.kind === 'enabled' && (
          <button
            type="button"
            onClick={handleRemoveDevice}
            disabled={busy}
            className="mt-4 text-xs text-text-tertiary underline-offset-4 hover:text-text-secondary hover:underline disabled:opacity-50"
          >
            Remove this device
          </button>
        )}

        {state.kind === 'permission_denied' && (
          <p className="mt-3 text-xs text-text-tertiary">
            Notifications are blocked at the browser level. Enable them in your browser&rsquo;s site
            settings, then come back here.
          </p>
        )}

        {state.kind === 'unsupported' && (
          <p className="mt-3 text-xs text-text-tertiary">
            {state.reason === 'no_vapid_key'
              ? 'Push delivery is not configured for this environment.'
              : 'This browser doesn’t support web push.'}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-danger-soft-fg">
          {error}
        </p>
      )}
    </section>
  );
}

interface ToggleControlProps {
  state: ToggleState;
  busy: boolean;
  onEnable: () => void | Promise<void>;
  onTogglePref: (nextOn: boolean) => void | Promise<void>;
}

function ToggleControl({ state, busy, onEnable, onTogglePref }: ToggleControlProps) {
  if (state.kind === 'loading') {
    return <span className="text-xs text-text-tertiary">…</span>;
  }
  if (state.kind === 'unsupported' || state.kind === 'permission_denied') {
    return <DisabledPill label={state.kind === 'permission_denied' ? 'Blocked' : 'Off'} />;
  }
  if (state.kind === 'idle') {
    return (
      <button
        type="button"
        onClick={() => void onEnable()}
        disabled={busy}
        className="rounded-full bg-accent-primary px-3 py-1 text-xs font-semibold text-text-on-accent transition disabled:opacity-50"
      >
        Enable
      </button>
    );
  }
  // Enabled — show an On/Off toggle that flips the preference.
  return (
    <button
      type="button"
      onClick={() => void onTogglePref(!state.prefOn)}
      disabled={busy}
      aria-pressed={state.prefOn}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
        state.prefOn
          ? 'bg-accent-primary text-text-on-accent'
          : 'bg-surface-shell text-text-secondary'
      }`}
    >
      {state.prefOn ? 'On' : 'Off'}
    </button>
  );
}

function DisabledPill({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-surface-shell px-3 py-1 text-xs font-semibold text-text-tertiary">
      {label}
    </span>
  );
}
