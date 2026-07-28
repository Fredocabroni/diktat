// Tribe placement quiz. A short set of concrete-tradeoff questions places the
// user into the tribe they lean toward (see docs/TRIBE_OVERHAUL_PLAN.md). When the
// answers land between the two pairs that geometrically bleed (Progressive/Liberal
// or Populist/Nationalist) a short tie-breaker runs; otherwise the result leads
// with the nearest tribe. A mandatory override always lets the user pick any of
// the seven, or skip — nothing is locked: ADDICTION_ARCHITECTURE §11 (no forced
// choice to proceed, no FOMO).
//
// Flow (v2): select an option (it locks in visibly), then Next. Back re-opens the
// previous question with its choice restored and recomputes from there — answers
// live in a plain array and resolveCore/resolveTiebreak are pure, so editing just
// re-runs. Motion is a fighting-game character-select: sharp directional slides
// with momentum, a lock-in snap on select, and an impact reveal on "You lean X".
// All gated by useReducedMotion. Pure frontend: content + scoring live in ./quiz;
// joining reuses trpc.tribes.list / trpc.tribes.join.

'use client';

import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { trpc } from '../../../lib/trpc';
import {
  CORE_QUESTIONS,
  QUIZ_INTRO,
  TIEBREAK_BANKS,
  type TiebreakKey,
  resolveCore,
  resolveTiebreak,
} from './quiz';

// Sharp ease-out with momentum (fast start, quick settle) — the character-select
// whip. Exit is the same curve reversed by the directional offset.
const EASE_SNAP: [number, number, number, number] = [0.16, 1, 0.3, 1];
const SLIDE_PX = 64;

type Origin =
  | { readonly kind: 'core' }
  | { readonly kind: 'tiebreak'; readonly branch: TiebreakKey; readonly coreBest: string };

type Phase =
  | { readonly kind: 'core'; readonly step: number }
  | {
      readonly kind: 'tiebreak';
      readonly branch: TiebreakKey;
      readonly step: number;
      readonly coreBest: string;
    }
  | {
      readonly kind: 'result';
      readonly slug: string;
      readonly showAll: boolean;
      readonly origin: Origin;
    };

interface TribeRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly manifesto: string | null;
}

const LAST_CORE = CORE_QUESTIONS.length - 1;

export default function OnboardTribePage() {
  return (
    <LazyMotion features={domAnimation}>
      <TribeQuiz />
    </LazyMotion>
  );
}

function TribeQuiz() {
  const router = useRouter();
  const reduceMotion = useReducedMotion() ?? false;
  const tribes = trpc.tribes.list.useQuery();

  const [coreAnswers, setCoreAnswers] = useState<(number | undefined)[]>([]);
  const [tiebreakAnswers, setTiebreakAnswers] = useState<(number | undefined)[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'core', step: 0 });
  // +1 = advancing, -1 = going back. Drives the slide direction.
  const [dir, setDir] = useState(1);

  const bySlug = useMemo(() => {
    const map = new Map<string, TribeRow>();
    for (const t of (tribes.data ?? []) as TribeRow[]) map.set(t.slug, t);
    return map;
  }, [tribes.data]);

  const join = trpc.tribes.join.useMutation({
    onSuccess: () => router.push('/onboard/preview'),
  });

  function selectCore(i: number) {
    if (phase.kind !== 'core') return;
    const next = [...coreAnswers];
    next[phase.step] = i;
    setCoreAnswers(next);
  }

  function selectTiebreak(i: number) {
    if (phase.kind !== 'tiebreak') return;
    const next = [...tiebreakAnswers];
    next[phase.step] = i;
    setTiebreakAnswers(next);
  }

  function nextFromCore() {
    if (phase.kind !== 'core' || coreAnswers[phase.step] === undefined) return;
    setDir(1);
    if (phase.step < LAST_CORE) {
      setPhase({ kind: 'core', step: phase.step + 1 });
      return;
    }
    const result = resolveCore(coreAnswers.map((a) => a ?? -1));
    if (result.branch) {
      setTiebreakAnswers([]);
      setPhase({ kind: 'tiebreak', branch: result.branch, step: 0, coreBest: result.best });
    } else {
      // Confident placement, or low-confidence / off-pair → open the override.
      setPhase({
        kind: 'result',
        slug: result.best,
        showAll: result.showOverride,
        origin: { kind: 'core' },
      });
    }
  }

  function nextFromTiebreak() {
    if (phase.kind !== 'tiebreak' || tiebreakAnswers[phase.step] === undefined) return;
    setDir(1);
    const bank = TIEBREAK_BANKS[phase.branch];
    if (phase.step < bank.questions.length - 1) {
      setPhase({ ...phase, step: phase.step + 1 });
      return;
    }
    const slug = resolveTiebreak(
      phase.branch,
      tiebreakAnswers.map((a) => a ?? -1),
      phase.coreBest,
    );
    setPhase({
      kind: 'result',
      slug,
      showAll: false,
      origin: { kind: 'tiebreak', branch: phase.branch, coreBest: phase.coreBest },
    });
  }

  function goBack() {
    setDir(-1);
    if (phase.kind === 'core') {
      if (phase.step > 0) setPhase({ kind: 'core', step: phase.step - 1 });
      return;
    }
    if (phase.kind === 'tiebreak') {
      if (phase.step > 0) setPhase({ ...phase, step: phase.step - 1 });
      else setPhase({ kind: 'core', step: LAST_CORE }); // re-open the last core question
      return;
    }
    // From the result, step back into whichever question produced it.
    if (phase.origin.kind === 'core') {
      setPhase({ kind: 'core', step: LAST_CORE });
    } else {
      const bank = TIEBREAK_BANKS[phase.origin.branch];
      setPhase({
        kind: 'tiebreak',
        branch: phase.origin.branch,
        step: bank.questions.length - 1,
        coreBest: phase.origin.coreBest,
      });
    }
  }

  function pick(slug: string) {
    if (join.isPending) return;
    const tribe = bySlug.get(slug);
    if (!tribe) return;
    join.mutate({ tribeId: tribe.id });
  }

  const stepKey =
    phase.kind === 'core'
      ? `core-${phase.step}`
      : phase.kind === 'tiebreak'
        ? `tb-${phase.branch}-${phase.step}`
        : 'result';

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col overflow-hidden px-6 py-10">
      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <m.div
          key={stepKey}
          custom={dir}
          variants={{
            enter: (d: number) => ({ x: reduceMotion ? 0 : d * SLIDE_PX, opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (d: number) => ({ x: reduceMotion ? 0 : d * -SLIDE_PX, opacity: 0 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: reduceMotion ? 0.12 : 0.18, ease: EASE_SNAP }}
          className="flex flex-1 flex-col"
        >
          {phase.kind === 'core' && (
            <QuestionStep
              eyebrow={`Question ${phase.step + 1} of ${CORE_QUESTIONS.length}`}
              intro={phase.step === 0 ? QUIZ_INTRO : undefined}
              question={CORE_QUESTIONS[phase.step]!}
              selected={coreAnswers[phase.step]}
              onSelect={selectCore}
              onNext={nextFromCore}
              onBack={phase.step > 0 ? goBack : null}
              reduceMotion={reduceMotion}
            />
          )}
          {phase.kind === 'tiebreak' && (
            <QuestionStep
              eyebrow="Just to be sure"
              question={TIEBREAK_BANKS[phase.branch].questions[phase.step]!}
              selected={tiebreakAnswers[phase.step]}
              onSelect={selectTiebreak}
              onNext={nextFromTiebreak}
              onBack={goBack}
              reduceMotion={reduceMotion}
            />
          )}
          {phase.kind === 'result' && (
            <ResultView
              slug={phase.slug}
              showAll={phase.showAll}
              tribes={(tribes.data ?? []) as TribeRow[]}
              tribesLoading={tribes.isLoading}
              tribesError={tribes.isError}
              onRetry={() => void tribes.refetch()}
              onPick={pick}
              onShowAll={() => setPhase({ ...phase, showAll: true })}
              onBack={goBack}
              joinPending={join.isPending}
              joinError={join.isError}
              reduceMotion={reduceMotion}
            />
          )}
        </m.div>
      </AnimatePresence>
    </main>
  );
}

interface StepQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string }[];
}

function QuestionStep({
  eyebrow,
  intro,
  question,
  selected,
  onSelect,
  onNext,
  onBack,
  reduceMotion,
}: {
  eyebrow: string;
  intro?: string;
  question: StepQuestion;
  selected: number | undefined;
  onSelect: (i: number) => void;
  onNext: () => void;
  onBack: (() => void) | null;
  reduceMotion: boolean;
}) {
  const canNext = selected !== undefined;

  return (
    <div className="flex flex-1 flex-col">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-text-tertiary">
        {eyebrow}
      </p>
      {intro && <p className="mt-2 text-sm text-text-secondary">{intro}</p>}
      <h1 className="mt-2 font-display text-2xl font-bold tracking-tight text-text-primary">
        {question.prompt}
      </h1>

      <ul className="mt-6 space-y-3">
        {question.options.map((opt, i) => {
          const isSelected = selected === i;
          return (
            <li key={i}>
              <m.button
                type="button"
                onClick={() => onSelect(i)}
                aria-pressed={isSelected}
                animate={reduceMotion ? { scale: 1 } : { scale: isSelected ? [1, 1.04, 1] : 1 }}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                transition={{ duration: 0.22, ease: [0.3, 0, 0, 1] }}
                className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left text-sm transition-colors ${
                  isSelected
                    ? 'border-brand bg-surface-raised text-text-primary shadow-glow-violet ring-2 ring-brand/50'
                    : 'border-ink-300 bg-surface-card text-text-primary hover:border-brand hover:bg-surface-raised'
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 h-2 w-2 flex-none rounded-full transition-colors ${
                    isSelected ? 'bg-brand' : 'bg-ink-300'
                  }`}
                />
                <span>{opt.label}</span>
              </m.button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto pt-8">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-full border border-ink-300 px-5 py-3 text-sm font-semibold text-text-secondary transition hover:border-brand hover:text-text-primary"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            disabled={!canNext}
            className="flex-1 rounded-full bg-brand px-4 py-3 text-center font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            Next
          </button>
        </div>
        <div className="mt-4 flex justify-center">
          <Link
            href="/onboard/preview"
            className="rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
          >
            Skip
          </Link>
        </div>
      </div>
    </div>
  );
}

function ResultView({
  slug,
  showAll,
  tribes,
  tribesLoading,
  tribesError,
  onRetry,
  onPick,
  onShowAll,
  onBack,
  joinPending,
  joinError,
  reduceMotion,
}: {
  slug: string;
  showAll: boolean;
  tribes: readonly TribeRow[];
  tribesLoading: boolean;
  tribesError: boolean;
  onRetry: () => void;
  onPick: (slug: string) => void;
  onShowAll: () => void;
  onBack: () => void;
  joinPending: boolean;
  joinError: boolean;
  reduceMotion: boolean;
}) {
  const suggested = tribes.find((t) => t.slug === slug) ?? null;

  // Guard against a fetch that never settles (e.g. a black-holed request): if
  // we're still loading after a grace period, fall through to the error state
  // rather than spinning forever.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!tribesLoading) return;
    setTimedOut(false);
    const id = setTimeout(() => setTimedOut(true), 10_000);
    return () => clearTimeout(id);
  }, [tribesLoading]);

  const rise = (delay: number) => ({
    initial: { opacity: 0, y: reduceMotion ? 0 : 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, ease: EASE_SNAP, delay: reduceMotion ? 0 : delay },
  });

  // Nothing to show yet: skeleton while genuinely loading, otherwise a real
  // error state (fetch failed, timed out, or the tribe isn't in the list) with
  // Retry + Skip — never an eternal skeleton.
  if (!suggested) {
    if (tribesLoading && !timedOut) {
      return (
        <div className="space-y-4">
          <div className="h-6 w-40 animate-pulse rounded bg-ink-300" />
          <div className="h-32 animate-pulse rounded-2xl bg-surface-card/60" />
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-text-tertiary">
          Something went wrong
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight text-text-primary">
          Couldn&apos;t load tribes
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          {tribesError || timedOut
            ? 'We could not reach the server to load your tribe. Check your connection and try again.'
            : 'Your tribe could not be matched. Try again, or skip for now.'}
        </p>
        <div className="mt-auto pt-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="rounded-full border border-ink-300 px-5 py-3 text-sm font-semibold text-text-secondary transition hover:border-brand hover:text-text-primary"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onRetry}
              className="flex-1 rounded-full bg-brand px-4 py-3 text-center font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99]"
            >
              Retry
            </button>
          </div>
          <div className="mt-4 flex justify-center">
            <Link
              href="/onboard/preview"
              className="rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
            >
              Skip
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {!showAll && (
        <div>
          <m.p
            {...rise(0)}
            className="text-xs font-semibold uppercase tracking-[0.25em] text-text-tertiary"
          >
            You lean
          </m.p>
          <div className="relative mt-1">
            {!reduceMotion && (
              <m.div
                aria-hidden
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: [0, 0.7, 0], scale: 1.5 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="pointer-events-none absolute -inset-6 -z-10 rounded-full bg-brand/25 blur-2xl"
              />
            )}
            {/* The lock-in: the tribe name slams in from slightly oversized. */}
            <m.h1
              initial={{ scale: reduceMotion ? 1 : 1.3, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: reduceMotion ? 0.15 : 0.32, ease: EASE_SNAP }}
              className="font-display text-4xl font-black tracking-tight text-text-primary"
            >
              {suggested.name}
            </m.h1>
          </div>
          {suggested.manifesto && (
            <m.p {...rise(0.14)} className="mt-4 text-sm leading-relaxed text-text-secondary">
              {suggested.manifesto}
            </m.p>
          )}
          <m.div {...rise(0.22)} className="mt-6">
            <button
              type="button"
              onClick={() => onPick(suggested.slug)}
              disabled={joinPending}
              className="w-full rounded-full bg-brand px-4 py-3 text-center font-display font-bold text-brand-fg shadow-glow-violet transition hover:bg-brand/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {joinPending ? 'Joining…' : `Lock in ${suggested.name}`}
            </button>
            <button
              type="button"
              onClick={onShowAll}
              className="mt-3 w-full rounded-full px-4 py-2 text-sm font-semibold text-text-secondary transition hover:text-text-primary"
            >
              Not you? Pick another
            </button>
          </m.div>
        </div>
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
              <m.li key={t.id} {...rise(0.03 * i)}>
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

      <div className="mt-auto pt-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-full border border-ink-300 px-5 py-3 text-sm font-semibold text-text-secondary transition hover:border-brand hover:text-text-primary"
          >
            Back
          </button>
          <Link
            href="/onboard/preview"
            className="flex-1 rounded-full px-4 py-3 text-center text-sm font-semibold text-text-secondary transition hover:text-text-primary"
          >
            Skip
          </Link>
        </div>
      </div>
    </div>
  );
}
