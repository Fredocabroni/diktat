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
      <SessionNudgeSheet
        open={false}
        minutesElapsed={30}
        onContinue={() => {}}
        onLater={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('uses the §12 wording when open', () => {
    render(<SessionNudgeSheet open minutesElapsed={30} onContinue={() => {}} onLater={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/30 minutes\. Want to take a break\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Just 5 more minutes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /come back later/ })).toBeInTheDocument();
  });

  it('emits the right callbacks on each button', () => {
    const onContinue = vi.fn();
    const onLater = vi.fn();
    render(
      <SessionNudgeSheet open minutesElapsed={32} onContinue={onContinue} onLater={onLater} />,
    );
    screen.getByRole('button', { name: /come back later/ }).click();
    screen.getByRole('button', { name: /Just 5 more minutes/ }).click();
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
