import type { Meta, StoryObj } from '@storybook/react';

import { BattleResult } from './BattleResult.js';
import { ChoiceButton } from './ChoiceButton.js';
import { QuestionCard } from './QuestionCard.js';
import { RoundTimer } from './RoundTimer.js';

const meta: Meta = {
  title: 'Battle/Primitives',
};

export default meta;

const SAMPLE_QUESTION = {
  prompt: 'Which agency publishes the monthly Consumer Price Index release?',
  choices: ['Treasury', 'Federal Reserve', 'Bureau of Labor Statistics', 'OMB'],
  correctIndex: 2,
} as const;

export const QuestionCardIdle: StoryObj = {
  name: 'QuestionCard / fresh round',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <QuestionCard
        roundNo={0}
        totalRounds={5}
        prompt={SAMPLE_QUESTION.prompt}
        choices={[...SAMPLE_QUESTION.choices]}
        onSelect={(i) => console.info('selected', i)}
      />
    </div>
  ),
};

export const QuestionCardSelected: StoryObj = {
  name: 'QuestionCard / answer chosen',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <QuestionCard
        roundNo={2}
        totalRounds={5}
        prompt={SAMPLE_QUESTION.prompt}
        choices={[...SAMPLE_QUESTION.choices]}
        selectedIndex={2}
        onSelect={(i) => console.info('selected', i)}
      />
    </div>
  ),
};

export const QuestionCardRevealed: StoryObj = {
  name: 'QuestionCard / results revealed',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <QuestionCard
        roundNo={4}
        totalRounds={5}
        prompt={SAMPLE_QUESTION.prompt}
        choices={[...SAMPLE_QUESTION.choices]}
        selectedIndex={1}
        correctIndex={2}
        onSelect={() => {}}
      />
    </div>
  ),
};

export const QuestionCardPractice: StoryObj = {
  name: 'QuestionCard / practice match badge',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <QuestionCard
        roundNo={0}
        totalRounds={5}
        prompt={SAMPLE_QUESTION.prompt}
        choices={[...SAMPLE_QUESTION.choices]}
        practiceMatch
        onSelect={() => {}}
      />
    </div>
  ),
};

export const RoundTimerNormal: StoryObj = {
  name: 'RoundTimer / 8 seconds left',
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <RoundTimer totalSeconds={12} secondsLeft={8} />
    </div>
  ),
};

export const RoundTimerDanger: StoryObj = {
  name: 'RoundTimer / 2 seconds left',
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <RoundTimer totalSeconds={12} secondsLeft={2} />
    </div>
  ),
};

export const ChoiceMatrix: StoryObj = {
  name: 'ChoiceButton / state matrix',
  render: () => (
    <div style={{ display: 'grid', gap: 12, maxWidth: 320 }}>
      {(['idle', 'selected', 'correct', 'wrong'] as const).map((state, idx) => (
        <ChoiceButton key={state} index={idx} label={`${state}`} state={state} onClick={() => {}} />
      ))}
    </div>
  ),
};

export const BattleResultWin: StoryObj = {
  name: 'BattleResult / win + +28 AP',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <BattleResult
        rows={[
          {
            userId: 'u-1',
            handle: 'fmichael',
            correctCount: 4,
            totalLatencyMs: 11_000,
            isYou: true,
          },
          {
            userId: 'u-2',
            handle: 'rogerthatreddit',
            correctCount: 3,
            totalLatencyMs: 14_500,
            isYou: false,
          },
        ]}
        winnerUserId="u-1"
        apDelta={28}
        onPlayAgain={() => {}}
        onClose={() => {}}
      />
    </div>
  ),
};

export const BattleResultPracticeLoss: StoryObj = {
  name: 'BattleResult / practice loss',
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <BattleResult
        rows={[
          {
            userId: 'u-1',
            handle: 'fmichael',
            correctCount: 2,
            totalLatencyMs: 13_000,
            isYou: true,
          },
          {
            userId: 'bot-cool',
            handle: 'bot_calm_otter',
            correctCount: 4,
            totalLatencyMs: 9_000,
            isYou: false,
            isBot: true,
          },
        ]}
        winnerUserId="bot-cool"
        apDelta={0}
        practiceMatch
        onClose={() => {}}
      />
    </div>
  ),
};
