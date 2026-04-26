import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { BattleResult, ChoiceButton, QuestionCard, RoundTimer } from '../src/index.js';

afterEach(() => {
  cleanup();
});

describe('ChoiceButton', () => {
  it('renders the letter badge + label and emits onClick with the index', () => {
    const onClick = vi.fn<(i: number) => void>();
    render(<ChoiceButton index={2} label="Bureau of Labor Statistics" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: /Bureau of Labor Statistics/ });
    expect(btn.getAttribute('data-index')).toBe('2');
    btn.click();
    expect(onClick).toHaveBeenCalledWith(2);
  });

  it('reflects state via data-state and aria-pressed', () => {
    const { rerender, container } = render(<ChoiceButton index={0} label="A" onClick={() => {}} />);
    expect(container.querySelector('[data-state="idle"]')).not.toBeNull();
    rerender(<ChoiceButton index={0} label="A" onClick={() => {}} state="correct" />);
    const btn = container.querySelector('[data-state="correct"]') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(<ChoiceButton index={0} label="A" onClick={onClick} disabled />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('RoundTimer', () => {
  it('exposes a progressbar with the right aria-valuenow and label', () => {
    render(<RoundTimer totalSeconds={12} secondsLeft={5} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('12');
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
    expect(bar.getAttribute('aria-valuetext')).toBe('5 seconds left');
  });

  it('clamps to [0, totalSeconds]', () => {
    render(<RoundTimer totalSeconds={12} secondsLeft={-3} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('QuestionCard', () => {
  const QUESTION = {
    roundNo: 1,
    totalRounds: 5,
    prompt: 'Which agency publishes the CPI?',
    choices: ['Treasury', 'Fed', 'BLS', 'OMB'] as const,
  };

  it('renders the prompt + 4 choice buttons + round meta', () => {
    render(
      <QuestionCard
        roundNo={QUESTION.roundNo}
        totalRounds={QUESTION.totalRounds}
        prompt={QUESTION.prompt}
        choices={[...QUESTION.choices]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(QUESTION.prompt)).toBeInTheDocument();
    expect(screen.getByText('Round 2 / 5')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('emits onSelect with the index when a choice is clicked', () => {
    const onSelect = vi.fn<(i: number) => void>();
    const { container } = render(
      <QuestionCard
        roundNo={0}
        totalRounds={5}
        prompt="Q?"
        choices={['First', 'Second', 'Third', 'Fourth']}
        onSelect={onSelect}
      />,
    );
    const btn = container.querySelector(
      '[data-component="ChoiceButton"][data-index="1"]',
    ) as HTMLElement;
    btn.click();
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('reveals correct + wrong states once correctIndex is set', () => {
    const { container } = render(
      <QuestionCard
        roundNo={0}
        totalRounds={5}
        prompt="Q?"
        choices={['A', 'B', 'C', 'D']}
        selectedIndex={1}
        correctIndex={2}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('[data-state="correct"][data-index="2"]')).not.toBeNull();
    expect(container.querySelector('[data-state="wrong"][data-index="1"]')).not.toBeNull();
  });

  it('shows the practice-match badge when practiceMatch=true', () => {
    render(
      <QuestionCard
        roundNo={0}
        totalRounds={5}
        prompt="Q?"
        choices={['A', 'B', 'C', 'D']}
        practiceMatch
        onSelect={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Practice match/i)).toBeInTheDocument();
  });
});

describe('BattleResult', () => {
  const ROWS = [
    { userId: 'u-1', handle: 'me', correctCount: 4, totalLatencyMs: 10_000, isYou: true },
    { userId: 'u-2', handle: 'opp', correctCount: 3, totalLatencyMs: 12_000, isYou: false },
  ] as const;

  it('frames the outcome from the calling user perspective', () => {
    const { container, rerender } = render(<BattleResult rows={[...ROWS]} winnerUserId="u-1" />);
    expect(container.querySelector('[data-outcome="win"]')).not.toBeNull();

    rerender(<BattleResult rows={[...ROWS]} winnerUserId="u-2" />);
    expect(container.querySelector('[data-outcome="loss"]')).not.toBeNull();
  });

  it('renders each row with correct count, latency, and bot badge when applicable', () => {
    render(
      <BattleResult
        rows={[
          { ...ROWS[0]!, correctCount: 5 },
          { ...ROWS[1]!, isBot: true, handle: 'bot_calm_otter' },
        ]}
        winnerUserId="u-1"
      />,
    );
    expect(screen.getByText(/5 correct/)).toBeInTheDocument();
    expect(screen.getByText(/bot_calm_otter/)).toBeInTheDocument();
    expect(screen.getByText(/^bot$/i)).toBeInTheDocument();
  });

  it('shows the practice cap note when practiceMatch=true with apDelta', () => {
    render(<BattleResult rows={[...ROWS]} winnerUserId="u-1" apDelta={15} practiceMatch />);
    expect(screen.getByText(/practice — capped at 200\/day/)).toBeInTheDocument();
  });
});
