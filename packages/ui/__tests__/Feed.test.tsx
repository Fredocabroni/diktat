import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import {
  BattleThisCta,
  OpinionSlider,
  SessionNudgeSheet,
  SwipeCard,
  type OpinionPosition,
  type SwipeAction,
} from '../src/index.js';

afterEach(() => {
  cleanup();
});

const TOPIC = {
  id: 'topic-1',
  headline: 'Senate floor schedules a vote on the FY 2027 CR',
  summary: 'Cloture filed Monday; final-passage vote expected Thursday.',
  primarySource: { label: 'Congress.gov', url: 'https://www.congress.gov/' },
} as const;

describe('SwipeCard', () => {
  it('renders headline + summary + primary source attribution', () => {
    render(<SwipeCard topic={TOPIC} onAction={() => {}} />);
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.getByText(TOPIC.headline)).toBeInTheDocument();
    expect(screen.getByText(TOPIC.summary)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Congress\.gov/ }).getAttribute('href')).toBe(
      TOPIC.primarySource.url,
    );
  });

  it('emits onAction with the right action + topic id for each button', () => {
    const onAction = vi.fn<(a: SwipeAction, id: string) => void>();
    render(<SwipeCard topic={TOPIC} onAction={onAction} />);
    screen.getByRole('button', { name: 'Disagree' }).click();
    screen.getByRole('button', { name: 'Skip' }).click();
    screen.getByRole('button', { name: 'Agree' }).click();
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['disagree', 'skip', 'agree']);
    for (const call of onAction.mock.calls) {
      expect(call[1]).toBe(TOPIC.id);
    }
  });

  it('renders the battleCta slot when provided', () => {
    render(
      <SwipeCard
        topic={TOPIC}
        onAction={() => {}}
        battleCta={<BattleThisCta topicId={TOPIC.id} onClick={() => {}} />}
      />,
    );
    expect(screen.getByRole('button', { name: /Battle This/ })).toBeInTheDocument();
  });

  it('omits the summary node when not provided', () => {
    const { id, headline } = TOPIC;
    render(<SwipeCard topic={{ id, headline }} onAction={() => {}} />);
    expect(screen.queryByText(TOPIC.summary)).toBeNull();
  });
});

describe('OpinionSlider', () => {
  it('renders a range input with the right bounds and value', () => {
    render(<OpinionSlider value={0} onChange={() => {}} />);
    const input = screen.getByRole('slider') as HTMLInputElement;
    expect(input.min).toBe('-2');
    expect(input.max).toBe('2');
    expect(input.step).toBe('1');
    expect(input.value).toBe('0');
  });

  it('emits onChange with the typed enum on user input', () => {
    const onChange = vi.fn<(v: OpinionPosition) => void>();
    render(<OpinionSlider value={0} onChange={onChange} />);
    const input = screen.getByRole('slider') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('exposes the active label via aria-valuetext', () => {
    render(<OpinionSlider value={-2} onChange={() => {}} />);
    const input = screen.getByRole('slider');
    expect(input.getAttribute('aria-valuetext')).toBe('Strongly disagree');
  });
});

describe('BattleThisCta', () => {
  it('emits onClick with the topic id', () => {
    const onClick = vi.fn<(id: string) => void>();
    render(<BattleThisCta topicId="topic-7" onClick={onClick} />);
    screen.getByRole('button', { name: /Battle This/ }).click();
    expect(onClick).toHaveBeenCalledWith('topic-7');
  });

  it('respects the disabled prop', () => {
    const onClick = vi.fn<(id: string) => void>();
    render(<BattleThisCta topicId="topic-7" onClick={onClick} disabled />);
    const btn = screen.getByRole('button', { name: /Battle This/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('SessionNudgeSheet', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <SessionNudgeSheet open={false} onContinue={() => {}} onLater={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the §12 operator-contract copy when open', () => {
    // Exact wording from the P4 pre-launch batch spec:
    //   "You've been here 30 minutes. Take a break?"
    //   Buttons: "Keep going" / "Close for now"
    // Any drift here fails copy-linter + addiction-auditor regression.
    render(<SessionNudgeSheet open onContinue={() => {}} onLater={() => {}} />);
    expect(
      screen.getByText(/You.{1,2}ve been here 30 minutes\. Take a break\?/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Keep going$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Close for now$/ })).toBeInTheDocument();
  });

  it('is NON-blocking (no aria-modal, no full-screen backdrop)', () => {
    // Per operator contract: "never blocks content". The dialog has
    // dialog role for a11y, but NOT aria-modal, and the backdrop is
    // omitted entirely (positioned above the bottom tab bar, the rest
    // of the page stays interactive).
    render(<SessionNudgeSheet open onContinue={() => {}} onLater={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveAttribute('aria-modal');
    // The outer container has `pointer-events: none` so taps outside
    // the inner card pass through to the content behind it.
    expect(dialog.getAttribute('style') ?? '').toContain('pointer-events: none');
  });

  it('carries no urgency, scarcity, or come-back-tomorrow phrasing', () => {
    // Copy-linter guardrail pin. The subtitle was deliberately removed
    // (previous version carried "We'd rather you come back tomorrow
    // than burn out tonight.") — any regression that re-adds urgency
    // or scare framing fails this.
    const { container } = render(
      <SessionNudgeSheet open onContinue={() => {}} onLater={() => {}} />,
    );
    const text = container.textContent ?? '';
    const forbidden = [
      'come back tomorrow',
      'burn out',
      'miss out',
      "don't miss",
      'last chance',
      'running out',
      'almost gone',
      'limited',
    ];
    for (const bad of forbidden) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });

  it('emits the right callbacks on each button', () => {
    const onContinue = vi.fn();
    const onLater = vi.fn();
    render(<SessionNudgeSheet open onContinue={onContinue} onLater={onLater} />);
    screen.getByRole('button', { name: /^Keep going$/ }).click();
    screen.getByRole('button', { name: /^Close for now$/ }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
