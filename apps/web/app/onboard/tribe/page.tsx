// Tribe placement quiz. A short set of concrete-tradeoff questions places the
// user into the tribe they lean toward (see docs/TRIBE_QUIZ_PLAN.md), then offers
// a mandatory override — pick any of the five, or skip. Nothing is locked:
// ADDICTION_ARCHITECTURE §11 (no forced choice to proceed, no FOMO).
//
// Pure frontend: the quiz content + scoring live in ./quiz; joining reuses the
// existing trpc.tribes.list / trpc.tribes.join. No API/migration changes.

'use client';

import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { trpc } from '../../../lib/trpc';
import { QUIZ_QUESTIONS, resolveTribe } from './quiz';

// motion token: easing.standard — mutable 4-tuple so it satisfies Framer's
// BezierDefinition (a `readonly` tuple is rejected by the `ease` prop type).
const EASE_STANDARD: [number, number, number, number] = [0.2, 0, 0, 1];

type Phase =
  | { readonly kind: 'quiz'; readonly step: number }
  | { readonly kind: 'result'; readonly slug: string; readonly showAll: boolean };

interface TribeRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly manifesto: string | null;
}

export default function OnboardTribePage() {
  return (
    <LazyMotion features={domAnimation}>
      <TribeQuiz />
    </LazyMotion>
  );
}

function TribeQuiz() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const tribes = trpc.tribes.list.useQuery();

  const [answers, setAnswers] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'quiz', step: 0 });

  const bySlug = useMemo(() => {
    const map = new Map<string, TribeRow>();
    for (const t of (tribes.data ?? []) as TribeRow[]) map.set(t.slug, t);
    return map;
  }, [tribes.data]);

  const join = trpc.tribes.join.useMutation({
    onSuccess: () => router.push('/onboard/preview'),
  });

  function choose(optionIndex: number) {
    if (phase.kind !== 'quiz') return;
    const next = [...answers];
    next[phase.step] = optionIndex;
    setAnswers(next);

    if (phase.step + 1 < QUIZ_QUESTIONS.length) {
      setPhase({ kind: 'quiz', step: phase.step + 1 });
    } else {
      const result = resolveTribe(next);
      // Low-confidence → open straight to the all-five override.
      setPhase({ kind: 'result', slug: result.slug, showAll: !result.confident });
    }
  }

  function pick(slug: string) {
    if (join.isPending) return;
    const tribe = bySlug.get(slug);
    if (!tribe) return;
    join.mutate({ tribeId: tribe.id });
  }

  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: reduceMotion ? 0 : 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, ease: EASE_STANDARD, delay: reduceMotion ? 0 : delay },
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-10">
      {phase.kind === 'quiz' ? (
        <QuizStep step={phase.step} onChoose={choose} rise={rise} />
      ) : (
        <ResultView
          slug={phase.slug}
          showAll={phase.showAll}
          tribes={(tribes.data ?? []) as TribeRow[]}
          tribesLoading={tribes.isLoading}
          onPick={pick}
          onShowAll={() => setPhase({ ...phase, showAll: true })}
          joinPending={join.isPending}
          joinError={join.isError}
          rise={rise}
        />
      )}
    </main>
  );
}

type RiseFn = (delay?: number) => {
  initial: { opacity: number; y: number };
  animate: { opacity: number; y: number };
  transition: { duration: number; ease: [number, number, number, number]; delay: number };
};

function QuizStep({
  step,
  onChoose,
  rise,
}: {
  step: number;
  onChoose: (i: number) => void;
  rise: RiseFn;
}) {
  const q = QUIZ_QUESTIONS[step]!;
  const total = QUIZ_QUESTIONS.length;

  return (
    <div key={q.id}>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
        Question {step + 1} of {total}
      </p>
      <m.h1
        {...rise()}
        className="mt-2 font-display text-2xl font-bold tracking-tight text-text-primary"
      >
        {q.prompt}
      </m.h1>

      <ul className="mt-6 space-y-3">
        {q.options.map((opt, i) => (
          <m.li key={i} {...rise(0.05 + i * 0.05)}>
            <button
              type="button"
              onClick={() => onChoose(i)}
              className="w-full rounded-2xl border border-ink-300 bg-surface-card p-4 text-left text-sm text-text-primary transition hover:border-brand hover:bg-surface-raised"
            >
              {opt.label}
            </button>
          </m.li>
        ))}
      </ul>

      <div className="mt-8 flex justify-center pb-4">
        <Link
          href="/onboard/preview"
          className="rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
        >
          Skip
        </Link>
      </div>
    </div>
  );
}

function ResultView({
  slug,
  showAll,
  tribes,
  tribesLoading,
  onPick,
  onShowAll,
  joinPending,
  joinError,
  rise,
}: {
  slug: string;
  showAll: boolean;
  tribes: readonly TribeRow[];
  tribesLoading: boolean;
  onPick: (slug: string) => void;
  onShowAll: () => void;
  joinPending: boolean;
  joinError: boolean;
  rise: RiseFn;
}) {
  const suggested = tribes.find((t) => t.slug === slug) ?? null;

  if (tribesLoading || !suggested) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-40 animate-pulse rounded bg-ink-300" />
        <div className="h-32 animate-pulse rounded-2xl bg-surface-card/60" />
      </div>
    );
  }

  return (
    <div>
      {!showAll && (
        <m.div {...rise()}>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            You lean
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-text-primary">
            {suggested.name}
          </h1>
          {suggested.manifesto && (
            <p className="mt-4 text-sm leading-relaxed text-text-secondary">
              {suggested.manifesto}
            </p>
          )}
          <button
            type="button"
            onClick={() => onPick(suggested.slug)}
            disabled={joinPending}
            className="mt-6 w-full rounded-full bg-brand px-4 py-3 text-center font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            {joinPending ? 'Joining…' : `Join ${suggested.name}`}
          </button>
          <button
            type="button"
            onClick={onShowAll}
            className="mt-3 w-full rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
          >
            Not you? Pick another
          </button>
        </m.div>
      )}

      {showAll && (
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text-primary">
            Pick your tribe
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            These five. Choose the one that fits — you can change later.
          </p>
          <ul className="mt-6 space-y-3">
            {tribes.map((t, i) => (
              <m.li key={t.id} {...rise(0.04 * i)}>
                <button
                  type="button"
                  onClick={() => onPick(t.slug)}
                  disabled={joinPending}
                  className={`flex w-full flex-col items-start rounded-2xl border p-4 text-left transition hover:border-brand hover:bg-surface-raised disabled:opacity-60 ${
                    t.slug === slug
                      ? 'border-brand bg-surface-raised'
                      : 'border-ink-300 bg-surface-card'
                  }`}
                >
                  <p className="font-display text-lg font-bold text-text-primary">{t.name}</p>
                  {t.description && (
                    <p className="mt-1 text-sm text-text-secondary">{t.description}</p>
                  )}
                </button>
              </m.li>
            ))}
          </ul>
        </div>
      )}

      {joinError && (
        <p role="alert" className="mt-4 text-sm text-danger-soft-fg">
          Could not join that tribe. Try again, or skip.
        </p>
      )}

      <div className="mt-8 flex justify-center pb-4">
        <Link
          href="/onboard/preview"
          className="rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
        >
          Skip
        </Link>
      </div>
    </div>
  );
}
