import type { Meta, StoryObj } from '@storybook/react';
import * as React from 'react';

import { BattleThisCta } from './BattleThisCta.js';
import { OpinionSlider, type OpinionPosition } from './OpinionSlider.js';
import { SessionNudgeSheet } from './SessionNudgeSheet.js';
import { SwipeCard } from './SwipeCard.js';

const meta: Meta = {
  title: 'Feed/Primitives',
};

export default meta;

const SAMPLE_TOPIC = {
  id: 'topic-1',
  headline: 'Senate floor schedules a vote on the FY 2027 continuing resolution',
  summary:
    'Procedural cloture filed Monday; a final-passage vote expected Thursday after a week of negotiations on disaster supplemental amendments.',
  primarySource: { label: 'Congress.gov', url: 'https://www.congress.gov/' },
} as const;

export const SwipeCardDefault: StoryObj<typeof SwipeCard> = {
  name: 'SwipeCard / default',
  render: () => (
    <SwipeCard
      topic={SAMPLE_TOPIC}
      onAction={(action, id) => console.info('action', action, id)}
      battleCta={
        <BattleThisCta
          topicId={SAMPLE_TOPIC.id}
          onClick={(id) => console.info('battle this', id)}
        />
      }
    />
  ),
};

export const SwipeCardWithoutBattle: StoryObj<typeof SwipeCard> = {
  name: 'SwipeCard / no Battle CTA',
  render: () => <SwipeCard topic={SAMPLE_TOPIC} onAction={(a, id) => console.info(a, id)} />,
};

function OpinionSliderDemo(): React.ReactElement {
  const [value, setValue] = React.useState<OpinionPosition>(0);
  return <OpinionSlider value={value} onChange={setValue} />;
}

export const OpinionSliderInteractive: StoryObj = {
  name: 'OpinionSlider / interactive',
  render: () => <OpinionSliderDemo />,
};

export const OpinionSliderMatrix: StoryObj = {
  name: 'OpinionSlider / matrix',
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
      {([-2, -1, 0, 1, 2] as const).map((p) => (
        <OpinionSlider
          key={p}
          value={p}
          onChange={() => {
            /* noop in matrix */
          }}
        />
      ))}
    </div>
  ),
};

export const BattleThisCtaDefault: StoryObj<typeof BattleThisCta> = {
  name: 'BattleThisCta / default',
  render: () => <BattleThisCta topicId="topic-1" onClick={(id) => console.info(id)} />,
};

export const BattleThisCtaDisabled: StoryObj<typeof BattleThisCta> = {
  name: 'BattleThisCta / disabled',
  render: () => <BattleThisCta topicId="topic-1" onClick={(id) => console.info(id)} disabled />,
};

export const SessionNudgeSheetOpen: StoryObj<typeof SessionNudgeSheet> = {
  name: 'SessionNudgeSheet / open at 30 minutes',
  render: () => (
    <SessionNudgeSheet
      open
      minutesElapsed={30}
      onContinue={() => console.info('continue')}
      onLater={() => console.info('later')}
    />
  ),
};
