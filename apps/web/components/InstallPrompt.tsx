// A2HS prompt. Lives at the bottom of the screen as a dismissible pill,
// not a modal. Design constraints (enforced by addiction-auditor):
//   • Never blocks content.
//   • No countdown timer or urgency copy.
//   • Dismissal is remembered locally — we do not re-nag.
//   • Shows at most once per 7 days even if the user neither accepts nor
//     dismisses.
//
// The user remains in full control: if they want install later they can
// always use the browser's own "Add to Home Screen" affordance.

'use client';

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const STORAGE_KEY = 'diktat:install-prompt:last-shown';
const MIN_REPROMPT_MS = 7 * 24 * 60 * 60 * 1000;

function shouldShow(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const lastShown = Number.parseInt(raw, 10);
    if (Number.isNaN(lastShown)) return true;
    return Date.now() - lastShown > MIN_REPROMPT_MS;
  } catch {
    return true;
  }
}

function markShown() {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // Private browsing, etc. — just skip persistence.
  }
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault();
      if (!shouldShow()) return;
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
      markShown();
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  if (!visible || !deferred) return null;

  return (
    <div
      role="region"
      aria-label="Install Diktat on your home screen"
      className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-40 flex items-center justify-between gap-3 rounded-2xl border border-ink-300 bg-surface-card px-4 py-3 shadow-lg"
    >
      <p className="text-sm text-text-primary">Add Diktat to your home screen.</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-full px-3 py-1 text-xs text-text-secondary hover:text-text-primary"
          onClick={() => setVisible(false)}
        >
          Not now
        </button>
        <button
          type="button"
          className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-brand-fg hover:bg-brand/90"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setVisible(false);
            setDeferred(null);
          }}
        >
          Install
        </button>
      </div>
    </div>
  );
}
