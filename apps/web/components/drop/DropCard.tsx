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

import { SplitBar, type SplitState } from './SplitBar';
import { WhySourcesDialog } from './WhySourcesDialog';

export type DropCardVariant = 'live' | 'pre_drop';

export interface DropCardTopic {
  readonly id: string;
  readonly headline: string;
  readonly sourceTitle: string | null;
  readonly summary: string | null;
  readonly primarySourceUrl: string | null;
  readonly category: string | null;
  /** A4 (migration 20261012000000): neutral both-sides-or-single-sided
   *  explainer. null = either the row predates A4 OR generation failed;
   *  UI falls through to the raw primary_source_url link. */
  readonly factExplainer?: {
    readonly for_summary: string;
    readonly against_summary: string;
    readonly source_url: string;
    readonly posture: 'contested' | 'single_sided' | 'empirical';
  } | null;
}

export type StanceAction = 'agree' | 'disagree' | 'skip';
export type SelectedStance = 'agree' | 'disagree' | null;

export interface DropCardProps {
  readonly topic: DropCardTopic;
  readonly variant: DropCardVariant;
  /** Choose-step tap. For Agree/Disagree this flips local selection
   *  only (no mutation). Skip is still a visual no-op. The parent
   *  owns the selection state so a revisit to the topic keeps the
   *  current choice. */
  readonly onStance: (action: StanceAction) => void;
  readonly disabled?: boolean;
  readonly banner?: ReactNode;
  /** The user's current locked-in stance for this topic. Non-null →
   *  the card renders in locked mode: the matching button is sticky-
   *  on, the others are dimmed AND disabled (locked view), the
   *  stance-confirmation pill shows "locked · agree|disagree", and
   *  the split bar renders under the grid. "Changed my mind" opens
   *  editing. Server state (`feed.list.topics[*].userStance`) is the
   *  source on first load; the parent overrides it optimistically on
   *  successful Lock-it-in. */
  readonly locked?: SelectedStance;
  /** User's current CHOICE — the local, pre-submit selection. Non-
   *  null → shows "Lock it in" button under the grid. Ignored while
   *  `locked !== null && !editing` (locked view wins). */
  readonly chosen?: SelectedStance;
  /** True when the parent put the card into editing mode after a
   *  "Changed my mind" tap. In this mode the split bar is hidden,
   *  the stance grid is tappable, and the "Changed my mind" link
   *  disappears until a new Lock-it-in resolves. */
  readonly editing?: boolean;
  /** Tapping this fires the actual recordShift mutation. Always
   *  gated on `chosen !== null` by the parent; the card renders
   *  the button only when a choice is pending. */
  readonly onLockIn?: () => void;
  /** Mutation currently in flight. Disables both the stance grid
   *  and the Lock-it-in button. */
  readonly submitting?: boolean;
  /** The split payload for this topic (from feed.getSplit). The
   *  card renders this below the grid only in locked, non-editing
   *  mode. `undefined` → still loading (no bar shown); explicit
   *  state → render SplitBar. Parent decides when to fetch. */
  readonly split?: SplitState;
  /** Tapping "Changed my mind". Only rendered when `locked !== null
   *  && !editing`. */
  readonly onChangeMind?: () => void;
  /** No-Drop-day replay mode (P4 PR B). Hides the stance grid, the
   *  stance-confirmation pill, Lock-it-in, SplitBar and the Battle
   *  footer entirely so the card renders as a non-interactive
   *  receipt of yesterday's Drop. `onStance` is never called in
   *  this mode. */
  readonly readOnly?: boolean;
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
    // primary_source_url to .gov hosts (all HTTPS-only), and
    // drop-publish only writes rows whose source passes that filter.
    // But future writers to news_topics (manual ops insert, the
    // curator-channel path the curation_mode enum already
    // accommodates, an unreviewed migration) bypass that filter.
    //
    // Reject anything but HTTPS:
    //   - `javascript:`, `data:`, `blob:` → clickable XSS payload.
    //   - `http:` → mixed-content link from the production HTTPS app,
    //     trivially MITM-able on hostile networks. All .gov primary
    //     sources serve HTTPS, so this is a no-op for legitimate
    //     content and a clean rejection of mis-ingested rows.
    //     (PR #40 round-2 security-reviewer LOW #3.)
    //
    // Returns both the normalised href and the display host from the
    // SAME URL object, so the rendered anchor's href and the visible
    // label cannot drift apart in any future refactor — closes the
    // dual-state concern from the round-1 security-reviewer LOW.
    if (u.protocol !== 'https:') return null;
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
  locked = null,
  chosen = null,
  editing = false,
  onLockIn,
  submitting = false,
  split,
  onChangeMind,
  readOnly = false,
}: DropCardProps): React.JSX.Element {
  const source = parsePrimaryUrl(topic.primarySourceUrl);
  const categoryLabel = topic.category ? (CATEGORY_LABELS[topic.category] ?? topic.category) : null;
  const ritualKicker = variant === 'live' ? "Tonight's Drop" : "Yesterday's Drop";

  // Display mode:
  //   locked view    → `locked !== null && !editing`
  //   choose view    → anything else (fresh, editing, or no server stance)
  // Which button is visually "on":
  //   locked view    → the locked stance
  //   choose view    → the chosen stance (local, pre-submit)
  const isLockedView = locked !== null && !editing;
  const visualSelection: SelectedStance = isLockedView ? locked : chosen;
  const stanceButtonsDisabled = disabled || submitting || isLockedView;

  return (
    <article
      role="article"
      aria-labelledby={`drop-headline-${topic.id}`}
      data-component="DropCard"
      data-variant={variant}
      data-mode={readOnly ? 'read_only' : isLockedView ? 'locked' : 'choose'}
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

      {topic.factExplainer ? <FactExplainerPanel explainer={topic.factExplainer} /> : null}

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

      {readOnly ? null : (
        <div role="group" aria-label="Stance" className="mt-1 grid grid-cols-3 gap-3">
          <StanceButton
            label="Disagree"
            tone="danger"
            disabled={stanceButtonsDisabled}
            selected={visualSelection === 'disagree'}
            dimmed={visualSelection !== null && visualSelection !== 'disagree'}
            onClick={() => onStance('disagree')}
          />
          <StanceButton
            label="Skip"
            tone="neutral"
            disabled={stanceButtonsDisabled}
            selected={false}
            dimmed={visualSelection !== null}
            onClick={() => onStance('skip')}
          />
          <StanceButton
            label="Agree"
            tone="success"
            disabled={stanceButtonsDisabled}
            selected={visualSelection === 'agree'}
            dimmed={visualSelection !== null && visualSelection !== 'agree'}
            onClick={() => onStance('agree')}
          />
        </div>
      )}

      {/* Lock-it-in CTA. Only appears in the choose-step view with a
          pending (non-locked) selection. Full width per the spec. */}
      {!readOnly && !isLockedView && chosen !== null ? (
        <button
          type="button"
          data-component="DropCard.LockItInButton"
          data-stance={chosen}
          onClick={() => onLockIn?.()}
          disabled={submitting}
          className="rounded-xl bg-brand-accent px-4 py-3 text-sm font-semibold text-brand-accent-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'locking in.' : 'Lock it in'}
        </button>
      ) : null}

      {/* Locked confirmation + split bar + "changed my mind" link.
          Rendered only in locked view (post-successful lock-in or
          server-side stance on reload). */}
      {!readOnly && isLockedView ? (
        <div className="-mt-2 flex flex-col gap-3">
          <p
            role="status"
            aria-live="polite"
            data-component="DropCard.StanceConfirmation"
            data-stance={locked}
            className="text-sm text-text-secondary"
          >
            {`locked · ${locked}`}
          </p>
          {split ? <SplitBar split={split} /> : null}
          <button
            type="button"
            data-component="DropCard.ChangeMindButton"
            onClick={() => onChangeMind?.()}
            disabled={submitting}
            className="self-start text-xs text-text-tertiary underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Changed my mind
          </button>
        </div>
      ) : null}

      {readOnly ? (
        <WhySourcesDialog />
      ) : (
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
      )}
    </article>
  );
}

interface StanceButtonProps {
  readonly label: string;
  readonly tone: 'success' | 'danger' | 'neutral';
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** This button is the user's current stance for this topic.
   *  Sticky-on visual + aria-pressed. (P2.a.) */
  readonly selected?: boolean;
  /** Another button on the same card is selected. This button dims
   *  to signal non-selection without disabling (user can change
   *  their mind — "flip" is a non-progress-earning allowed path). */
  readonly dimmed?: boolean;
}

function StanceButton({
  label,
  tone,
  onClick,
  disabled,
  selected = false,
  dimmed = false,
}: StanceButtonProps): React.JSX.Element {
  const toneClass =
    tone === 'success'
      ? 'bg-success text-success-fg'
      : tone === 'danger'
        ? 'bg-danger text-danger-fg'
        : 'border border-ink-300 bg-surface-raised text-text-primary';
  // Selected: thicker ring + full opacity. Dimmed: half opacity.
  // Neither: baseline. Pointer stays active for every button so
  // changing one's mind remains a single tap.
  const stateClass = selected
    ? 'ring-2 ring-brand-accent ring-offset-2 ring-offset-surface-card'
    : dimmed
      ? 'opacity-60'
      : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      data-tone={tone}
      data-selected={selected ? 'true' : undefined}
      className={`rounded-xl px-3 py-3 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${toneClass} ${stateClass}`}
    >
      {label}
    </button>
  );
}

interface FactExplainerPanelProps {
  readonly explainer: NonNullable<DropCardTopic['factExplainer']>;
}

/** Renders the neutral fact explainer (A4). Posture steers the layout:
 *  'contested' shows two paragraphs side by side; 'single_sided' and
 *  'empirical' show a single paragraph. The against_summary is
 *  deliberately omitted on non-contested postures to avoid false-
 *  balance on empirical facts. */
function FactExplainerPanel({ explainer }: FactExplainerPanelProps): React.JSX.Element {
  const isContested = explainer.posture === 'contested';
  const kicker =
    explainer.posture === 'contested'
      ? 'the debate'
      : explainer.posture === 'empirical'
        ? 'the data says'
        : 'the primary source says';
  return (
    <section
      aria-label="Fact explainer"
      data-component="FactExplainerPanel"
      data-posture={explainer.posture}
      className="flex flex-col gap-3 rounded-xl border border-ink-300 bg-surface-raised p-4"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{kicker}</p>
      {isContested ? (
        <div className="flex flex-col gap-3 md:flex-row md:gap-4">
          <div className="flex-1" data-component="FactExplainerPanel.For">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-success">for</p>
            <p className="text-sm leading-relaxed text-text-primary">{explainer.for_summary}</p>
          </div>
          <div className="flex-1" data-component="FactExplainerPanel.Against">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-danger">
              against
            </p>
            <p className="text-sm leading-relaxed text-text-primary">{explainer.against_summary}</p>
          </div>
        </div>
      ) : (
        <p
          className="text-sm leading-relaxed text-text-primary"
          data-component="FactExplainerPanel.Single"
        >
          {explainer.for_summary}
        </p>
      )}
    </section>
  );
}
