import * as React from 'react';

export type SwipeAction = 'agree' | 'disagree' | 'skip';

export interface SwipeCardTopic {
  readonly id: string;
  readonly headline: string;
  readonly summary?: string;
  readonly primarySource?: { readonly label: string; readonly url: string };
}

export interface SwipeCardProps {
  readonly topic: SwipeCardTopic;
  readonly onAction: (action: SwipeAction, topicId: string) => void;
  readonly battleCta?: React.ReactNode;
  readonly className?: string;
}

/**
 * Visual primitive for one news card in the feed. Renders the headline,
 * a primary-source attribution, and the three action buttons that drive
 * an `opinion_shifts` write (agree / disagree / skip).
 *
 * Drag-gesture interactivity (vertical swipe-to-next, horizontal swipe-
 * to-stance) lands in a follow-up; this primitive is the visual shell
 * + callback shape that the wired feed page consumes.
 */
export function SwipeCard(props: SwipeCardProps): React.ReactElement {
  const { topic, onAction, battleCta, className } = props;

  return (
    <article
      role="article"
      aria-labelledby={`swipe-card-headline-${topic.id}`}
      data-component="SwipeCard"
      data-topic-id={topic.id}
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 24,
        borderRadius: 24,
        background: 'var(--color-surface-card, #1c1c1f)',
        color: 'var(--color-text-primary, #f2f2f7)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
        minHeight: 360,
        maxWidth: 480,
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2
          id={`swipe-card-headline-${topic.id}`}
          style={{
            fontFamily: 'var(--font-display, var(--font-sans, system-ui))',
            fontWeight: 700,
            fontSize: 22,
            lineHeight: 1.25,
            margin: 0,
          }}
        >
          {topic.headline}
        </h2>
        {topic.summary ? (
          <p
            style={{
              fontFamily: 'var(--font-sans, system-ui)',
              fontWeight: 400,
              fontSize: 15,
              lineHeight: 1.5,
              margin: 0,
              color: 'var(--color-text-secondary, #c7c7cc)',
            }}
          >
            {topic.summary}
          </p>
        ) : null}
      </header>

      {topic.primarySource ? (
        <a
          href={topic.primarySource.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular)',
            fontSize: 12,
            textDecoration: 'none',
            color: 'var(--color-text-secondary, #c7c7cc)',
            opacity: 0.85,
          }}
        >
          source · {topic.primarySource.label}
        </a>
      ) : null}

      <div style={{ flex: 1 }} />

      <div
        role="group"
        aria-label="Stance actions"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}
      >
        <ActionButton
          label="Disagree"
          tone="danger"
          onClick={() => onAction('disagree', topic.id)}
        />
        <ActionButton label="Skip" tone="neutral" onClick={() => onAction('skip', topic.id)} />
        <ActionButton label="Agree" tone="success" onClick={() => onAction('agree', topic.id)} />
      </div>

      {battleCta ? <div data-slot="battle-cta">{battleCta}</div> : null}
    </article>
  );
}

interface ActionButtonProps {
  readonly label: string;
  readonly tone: 'success' | 'danger' | 'neutral';
  readonly onClick: () => void;
}

function ActionButton({ label, tone, onClick }: ActionButtonProps): React.ReactElement {
  const palette =
    tone === 'success'
      ? { bg: 'var(--color-accent-success, #2dd36f)', fg: '#08110b' }
      : tone === 'danger'
        ? { bg: 'var(--color-accent-danger, #ff453a)', fg: '#ffffff' }
        : {
            bg: 'var(--color-surface-elevated, #2a2a2e)',
            fg: 'var(--color-text-primary, #f2f2f7)',
          };

  return (
    <button
      type="button"
      onClick={onClick}
      data-tone={tone}
      style={{
        appearance: 'none',
        border: 'none',
        borderRadius: 16,
        padding: '14px 12px',
        fontFamily: 'var(--font-sans, system-ui)',
        fontWeight: 600,
        fontSize: 15,
        background: palette.bg,
        color: palette.fg,
        cursor: 'pointer',
        transition: 'transform 120ms ease-out, opacity 120ms ease-out',
      }}
    >
      {label}
    </button>
  );
}
