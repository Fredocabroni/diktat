// Drop card — the full-screen daily ritual surface.
//
// Reads one news_topics row produced by the drop_publish pipeline
// (PR #38). Renders the Diktat-voice `headline`, the verbatim
// `source_title` as a "Source · " line, the .gov `primary_source_url`
// as the only authoritative source pill (§1 non-negotiable), the
// 11-bucket `category` chip, the rewritten `summary`, and three
// stance actions wired to feed.recordShift.
//
// Reserved slots (V1 not visible):
//   - factCheckVerdict — passed null; surfaces once trpc.factCheck
//     gains a topic-keyed getVerdict (deferred to the follow-up).
//   - additionalSources — V1 always []; the framing-sources writer
//     ships in a later V1.5 follow-up (#6 in the queue).
//   - Battle CTA — rendered disabled; PR #17/#28 territory.
//
// Variant prop controls header copy:
//   - 'live'      → today's Drop, full ritual treatment
//   - 'pre_drop'  → most-recent past Drop while we wait for tonight's

'use client';

import type { ReactNode } from 'react';

import { WhySourcesDialog } from './WhySourcesDialog';

export type DropCardVariant = 'live' | 'pre_drop';

export interface DropCardTopic {
  readonly id: string;
  readonly headline: string;
  readonly sourceTitle: string | null;
  readonly summary: string | null;
  readonly primarySourceUrl: string | null;
  readonly category: string | null;
}

export type StanceAction = 'agree' | 'disagree' | 'skip';

export interface DropCardProps {
  readonly topic: DropCardTopic;
  readonly variant: DropCardVariant;
  readonly onStance: (action: StanceAction) => void;
  readonly disabled?: boolean;
  readonly banner?: ReactNode;
}

const CATEGORY_LABELS: Record<string, string> = {
  congress: 'Congress',
  bls_labor: 'Labor',
  fed_monetary: 'Monetary',
  cbo_fiscal: 'Fiscal',
  scotus_judicial: 'Courts',
  doj_legal: 'Justice',
  sec_filings: 'Markets',
  state_election: 'Elections',
  census_demographic: 'Demographics',
  fed_press: 'Federal',
  general: 'General',
};

interface ParsedSource {
  readonly href: string;
  readonly host: string;
}

function parsePrimaryUrl(url: string | null): ParsedSource | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Defense in depth: the upstream news-ingest host allow-list at
    // packages/ai-fabric/src/prompts/drop-sources.ts restricts
    // primary_source_url to .gov hosts, and drop-publish only writes
    // rows whose source passes that filter. But future writers to
    // news_topics (manual ops insert, the curator-channel path the
    // curation_mode enum already accommodates, an unreviewed
    // migration) bypass that filter. A row with a `javascript:`,
    // `data:`, or `blob:` scheme here would render as a clickable
    // XSS payload — reject any non-http(s) scheme.
    //
    // Returns both the normalised href and the display host from the
    // SAME URL object, so the rendered anchor's href and the visible
    // label cannot drift apart in any future refactor — closes the
    // dual-state concern from the round-1 security-reviewer LOW.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { href: u.href, host: u.host.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

export function DropCard({
  topic,
  variant,
  onStance,
  disabled,
  banner,
}: DropCardProps): React.JSX.Element {
  const source = parsePrimaryUrl(topic.primarySourceUrl);
  const categoryLabel = topic.category ? (CATEGORY_LABELS[topic.category] ?? topic.category) : null;
  const ritualKicker = variant === 'live' ? "Tonight's Drop" : "Yesterday's Drop";

  return (
    <article
      role="article"
      aria-labelledby={`drop-headline-${topic.id}`}
      data-component="DropCard"
      data-variant={variant}
      className="flex flex-col gap-5 rounded-2xl border border-ink-300 bg-surface-card p-6 shadow-lg"
    >
      {banner}

      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-brand-accent">
            {ritualKicker}
          </p>
          {categoryLabel ? (
            <span className="rounded-full border border-ink-300 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
              {categoryLabel}
            </span>
          ) : null}
        </div>
        <h1
          id={`drop-headline-${topic.id}`}
          className="font-display text-2xl font-bold leading-tight text-text-primary"
        >
          {topic.headline}
        </h1>
        {topic.sourceTitle ? (
          <p className="text-sm italic text-text-tertiary">Source · {topic.sourceTitle}</p>
        ) : null}
      </header>

      {topic.summary ? (
        <p className="text-sm leading-relaxed text-text-secondary">{topic.summary}</p>
      ) : null}

      {source ? (
        <a
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-2 rounded-full border border-brand-accent/40 bg-brand-accent/10 px-3 py-1.5 font-mono text-xs text-brand-accent"
        >
          <span aria-hidden>↗</span>
          {source.host}
        </a>
      ) : null}

      <div role="group" aria-label="Stance" className="mt-1 grid grid-cols-3 gap-3">
        <StanceButton
          label="Disagree"
          tone="danger"
          disabled={disabled}
          onClick={() => onStance('disagree')}
        />
        <StanceButton
          label="Skip"
          tone="neutral"
          disabled={disabled}
          onClick={() => onStance('skip')}
        />
        <StanceButton
          label="Agree"
          tone="success"
          disabled={disabled}
          onClick={() => onStance('agree')}
        />
      </div>

      <footer className="flex items-center justify-between gap-3 pt-1">
        <WhySourcesDialog />
        <button
          type="button"
          disabled
          aria-disabled
          data-component="BattleThisCta.disabled"
          className="cursor-not-allowed rounded-xl border border-ink-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary"
        >
          Battle · locked
        </button>
      </footer>
    </article>
  );
}

interface StanceButtonProps {
  readonly label: string;
  readonly tone: 'success' | 'danger' | 'neutral';
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

function StanceButton({ label, tone, onClick, disabled }: StanceButtonProps): React.JSX.Element {
  const toneClass =
    tone === 'success'
      ? 'bg-success text-success-fg'
      : tone === 'danger'
        ? 'bg-danger text-danger-fg'
        : 'border border-ink-300 bg-surface-raised text-text-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tone={tone}
      className={`rounded-xl px-3 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {label}
    </button>
  );
}
