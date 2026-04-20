// Handle editor. Client component because it owns local form state and
// fires a tRPC mutation. Validation mirrors the server (`/^[a-z0-9_]+$/i`,
// 3–24 chars) so the user gets instant feedback without round-tripping.
//
// Accessibility: dialog role + labelled by heading, focus traps to the
// input on open, esc-to-close handled at the document level.

'use client';

import { useEffect, useRef, useState } from 'react';

import { trpc } from '../../lib/trpc';

const HANDLE_REGEX = /^[a-z0-9_]+$/i;

function validate(handle: string): string | null {
  if (handle.length < 3) return 'Handle is too short.';
  if (handle.length > 24) return 'Handle is too long.';
  if (!HANDLE_REGEX.test(handle)) return 'Letters, numbers, and underscores only.';
  return null;
}

export function HandleEditModal({
  initialHandle,
  onClose,
  onSaved,
}: {
  initialHandle: string;
  onClose: () => void;
  onSaved: (handle: string) => void;
}) {
  const [value, setValue] = useState(initialHandle);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const updateHandle = trpc.user.updateHandle.useMutation({
    onSuccess: async ({ handle }) => {
      await utils.user.me.invalidate();
      onSaved(handle);
    },
    onError: (err) => {
      setError(err.data?.code === 'CONFLICT' ? 'That handle is taken.' : err.message);
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const v = validate(trimmed);
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    updateHandle.mutate({ handle: trimmed });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="handle-edit-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-[env(safe-area-inset-bottom)] sm:items-center"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-surface-elevated p-5 ring-1 ring-white/10"
      >
        <h2 id="handle-edit-title" className="font-display text-lg font-bold">
          Choose a handle
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Letters, numbers, and underscores. 3–24 characters.
        </p>
        <input
          ref={inputRef}
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-4 w-full rounded-xl border border-white/10 bg-surface-app px-4 py-3 text-text-primary"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'handle-edit-error' : undefined}
        />
        {error && (
          <p id="handle-edit-error" className="mt-2 text-sm text-accent-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={updateHandle.isPending}
            className="rounded-full bg-accent-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {updateHandle.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
