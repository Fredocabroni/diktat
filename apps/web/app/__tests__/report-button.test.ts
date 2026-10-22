// Source-pin tests for the ReportButton component + its mount on the
// ArgumentsTimeline. Copy invariants: no "help us keep the community
// safe" nudge, no post-submission guilt, button is a plain verb.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const COMPONENT = readFileSync(
  new URL('../../components/report/ReportButton.tsx', import.meta.url),
  'utf8',
);
const TIMELINE = readFileSync(
  new URL('../../components/open-debate/ArgumentsTimeline.tsx', import.meta.url),
  'utf8',
);

describe('ReportButton — wiring', () => {
  it('uses the trpc.reports.submit mutation', () => {
    expect(COMPONENT).toMatch(/trpc\.reports\.submit\.useMutation/);
  });

  it('takes a typed targetType + targetId prop', () => {
    expect(COMPONENT).toMatch(/'debate_arg' \| 'debate_post' \| 'drop' \| 'user'/);
    expect(COMPONENT).toMatch(/targetId: string/);
  });

  it('threads targetType + targetId + reason into the mutation call', () => {
    expect(COMPONENT).toMatch(/submit\.mutateAsync\(\{ targetType, targetId, reason \}\)/);
  });

  it('uses one submit step (not a two-step "are you sure?" nag)', () => {
    expect(COMPONENT).toMatch(/type Phase = 'idle' \| 'open' \| 'submitting' \| 'done' \| 'error'/);
  });
});

describe('ReportButton — copy invariants', () => {
  it('button label is a plain verb', () => {
    // Not "Report this post" / "Flag" / "I don't like this" — bare "Report".
    expect(COMPONENT).toMatch(/>\s*Report\s*<\/button>/);
  });

  it('confirmation copy is factual, not performative', () => {
    // "Report sent." — direct, no "Thank you for keeping us safe".
    expect(COMPONENT).toMatch(/>\s*Report sent\.\s*</);
  });

  it('is free of guilt / performative / coaching vocabulary', () => {
    const forbidden = [
      /thank you/i,
      /keep (the )?community safe/i,
      /we appreciate/i,
      /you(?:'| a)re a good/i,
      /flagging/i,
      /abuse/i,
      /violation/i,
    ];
    for (const re of forbidden) {
      expect(COMPONENT).not.toMatch(re);
    }
  });

  it('asks why in a direct second-person question (not boilerplate)', () => {
    expect(COMPONENT).toMatch(/Why are you reporting this\?/);
  });

  it('submit requires a non-empty reason', () => {
    expect(COMPONENT).toMatch(/if \(reason\.trim\(\)\.length === 0\)/);
  });
});

describe('ArgumentsTimeline — mount condition', () => {
  it('imports ReportButton', () => {
    expect(TIMELINE).toMatch(/import \{ ReportButton \} from '[./]+report\/ReportButton'/);
  });

  it("mounts the button only on others' revealed arguments (not yours, not forfeits)", () => {
    // Report-on-self would be noise; report-on-forfeit targets no
    // argument content.
    expect(TIMELINE).toMatch(/!isForfeit && !isYou && arg\?\.id/);
    expect(TIMELINE).toMatch(/<ReportButton targetType="debate_arg" targetId=\{arg\.id\}/);
  });
});
