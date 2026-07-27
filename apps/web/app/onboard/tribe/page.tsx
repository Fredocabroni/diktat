// Tribe placement quiz. A short set of concrete-tradeoff questions places the
// user into the tribe they lean toward (see docs/TRIBE_OVERHAUL_PLAN.md). When the
// answers land between the two pairs that geometrically bleed (Progressive/Liberal
// or Populist/Nationalist) a short tie-breaker runs; otherwise the result leads
// with the nearest tribe. A mandatory override always lets the user pick any of
// the seven, or skip — nothing is locked: ADDICTION_ARCHITECTURE §11 (no forced
// choice to proceed, no FOMO).
//
// Pure frontend: the quiz content + scoring live in ./quiz; joining reuses the
// existing trpc.tribes.list / trpc.tribes.join. No API/migration changes.

'use client';

import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { trpc } from '../../../lib/trpc';
import {
  CORE_QUESTIONS,
  TIEBREAK_BANKS,
  type TiebreakKey,
  resolveCore,
  resolveTiebreak,
} from './quiz';

// motion token: easing.standard — mutable 4-tuple so it satisfies Framer's
// BezierDefinition (a `readonly` tuple is rejected by the `ease` prop type).
const EASE_STANDARD: [number, number, number, number] = [0.2, 0, 0, 1];

type Phase =
  | { readonly kind: 'core'; readonly step: number }
  | {
      readonly kind: 'tiebreak';
      readonly branch: TiebreakKey;
      readonly step: number;
      readonly coreBest: string;
    }
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

  const [coreAnswers, setCoreAnswers] = useState<number[]>([]);
  const [tiebreakAnswers, setTiebreakAnswers] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'core', step: 0 });

  const bySlug = useMemo(() => {
    const map = new Map<string, TribeRow>();
    for (const t of (tribes.data ?? []) as TribeRow[]) map.set(t.slug, t);
    return map;
  }, [tribes.data]);

  const join = trpc.tribes.join.useMutation({
    onSuccess: () => router.push('/onboard/preview'),
  });

  function place(coreBest: string, tbAnswers: number[], branch: TiebreakKey) {
    const slug = resolveTiebreak(branch, tbAnswers, coreBest);
    setPhase({ kind: 'result', slug, showAll: false });
  }

  function chooseCore(optionIndex: number) {
    if (phase.kind !== 'core') return;
    const next = [...coreAnswers];
    next[phase.step] = optionIndex;
    setCoreAnswers(next);

    if (phase.step + 1 < CORE_QUESTIONS.length) {
      setPhase({ kind: 'core', step: phase.step + 1 });
      return;
    }
    const result = resolveCore(next);
    if (result.branch) {
      setTiebreakAnswers([]);
      setPhase({ kind: 'tiebreak', branch: result.branch, step: 0, coreBest: result.best });
    } else {
      // Confident placement, or low-confidence/off-pair → open the override.
      setPhase({ kind: 'result', slug: result.best, showAll: result.showOverride });
    }
  }

  function chooseTiebreak(optionIndex: number) {
    if (phase.kind !== 'tiebreak') return;
    const next = [...tiebreakAnswers];
    next[phase.step] = optionIndex;
    setTiebreakAnswers(next);

    const bank = TIEBREAK_BANKS[phase.branch];
    if (phase.step + 1 < bank.questions.length) {
      setPhase({ ...phase, step: phase.step + 1 });
    } else {
      place(phase.coreBest, next, phase.branch);
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
      {phase.kind === 'core' && (
        <QuestionStep
          eyebrow={`Question ${phase.step + 1} of ${CORE_QUESTIONS.length}`}
          question={CORE_QUESTIONS[phase.step]!}
          onChoose={chooseCore}
          rise={rise}
        />
      )}
      {phase.kind === 'tiebreak' && (
        <QuestionStep
          eyebrow="Just to be sure"
          question={TIEBREAK_BANKS[phase.branch].questions[phase.step]!}
          onChoose={chooseTiebreak}
          rise={rise}
        />
      )}
      {phase.kind === 'result' && (
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

interface StepQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string }[];
}

function QuestionStep({
  eyebrow,
  question,
  onChoose,
  rise,
}: {
  eyebrow: string;
  question: StepQuestion;
  onChoose: (i: number) => void;
  rise: RiseFn;
}) {
  return (
    <div key={question.id}>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{eyebrow}</p>
      <m.h1
        {...rise()}
        className="mt-2 font-display text-2xl font-bold tracking-tight text-text-primary"
      >
        {question.prompt}
      </m.h1>

      <ul className="mt-6 space-y-3">
        {question.options.map((opt, i) => (
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
            Choose the one that fits. You can switch anytime.
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
