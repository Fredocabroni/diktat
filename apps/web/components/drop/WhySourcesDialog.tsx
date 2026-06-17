// "Why these sources?" affordance + modal. Closes addiction flag #4:
// the primary-sources-only contract is invisible to users until they
// look for it; this turns the contract into a visible, one-tap
// transparency surface. §12 trust-builder by design.
//
// Implementation note: the <dialog> element gives us a native modal
// with backdrop + Escape-to-close, no portal acrobatics.

'use client';

import { useCallback, useEffect, useRef } from 'react';

interface WhySourcesDialogProps {
  readonly className?: string;
}

export function WhySourcesDialog({ className }: WhySourcesDialogProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  const open = useCallback(() => {
    ref.current?.showModal();
  }, []);

  const close = useCallback(() => {
    ref.current?.close();
  }, []);

  // Close on backdrop click (native <dialog> doesn't do this by default).
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClick = (e: MouseEvent) => {
      if (e.target === dialog) dialog.close();
    };
    dialog.addEventListener('click', onClick);
    return () => dialog.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={open}
        data-component="WhySourcesDialog.trigger"
        className={`text-xs font-medium text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline ${className ?? ''}`}
      >
        Why these sources?
      </button>
      <dialog
        ref={ref}
        data-component="WhySourcesDialog"
        className="rounded-2xl border border-ink-300 bg-surface-card p-6 text-text-primary backdrop:bg-surface-scrim sm:max-w-md"
      >
        <h2 className="font-display text-lg font-semibold">Primary sources only.</h2>
        <p className="mt-3 text-sm text-text-secondary">
          Diktat reads from primary government sources — Congress, BLS, SEC, the courts. Mainstream
          coverage appears as framing context only — never as the truth source.
        </p>
        <p className="mt-3 text-sm text-text-secondary">
          The link on every Drop points to the original record. Read it.
        </p>
        <button
          type="button"
          onClick={close}
          className="mt-5 w-full rounded-xl bg-brand-primary px-4 py-3 text-sm font-semibold text-brand-primary-fg"
        >
          Got it
        </button>
      </dialog>
    </>
  );
}
