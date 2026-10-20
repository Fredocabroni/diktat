// Source-level pins for the no-Drop-day Home variant (P4 PR B).
// vitest.config.ts scopes the suite to Node env, so React rendering
// isn't exercised here; these tests read DropFeedClient.tsx and
// DropCard.tsx as source and pin the structural + copy invariants
// the operator contract depends on.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DROP_FEED = readFileSync(new URL('../DropFeedClient.tsx', import.meta.url), 'utf8');
const DROP_CARD = readFileSync(new URL('../DropCard.tsx', import.meta.url), 'utf8');

describe('DropFeedClient — no-Drop-day state', () => {
  it('classifies a past-dated Drop as `no_drop_today`, not `pre_drop`', () => {
    // `pre_drop` is retained only for the defensive future-dated
    // branch. The real no-Drop-today case now routes to the new state.
    expect(DROP_FEED).toMatch(/kind: 'no_drop_today'; topic: DropTopic/);
    expect(DROP_FEED).toMatch(
      /dropEtYmd === todayEtYmd \? \{ kind: 'live', topic \} : \{ kind: 'no_drop_today', topic \}/,
    );
  });

  it('renders the honest banner line the operator contract requires', () => {
    expect(DROP_FEED).toMatch(/No Drop today\. Nothing cleared the bar\./);
  });

  it('offers a primary CTA to /take5', () => {
    expect(DROP_FEED).toMatch(/href="\/take5"/);
    expect(DROP_FEED).toMatch(/NoDropTodayPanel\.Cta/);
    // The CTA is also rendered as the text "Take 5" inside the Link.
    // Formatter may wrap whitespace, so match loosely with \s*.
    expect(DROP_FEED).toMatch(/>\s*Take 5\s*</);
  });

  it("renders yesterday's DropCard with readOnly=true", () => {
    // Read-only replay — the user cannot stance on yesterday's
    // Drop from the Home no-Drop state.
    const panel = DROP_FEED.slice(DROP_FEED.indexOf('NoDropTodayPanel'));
    expect(panel).toMatch(/readOnly/);
  });

  it('does NOT render the NextDropCountdown on the no-Drop state', () => {
    // The user said no "come back tomorrow" nudges. The countdown
    // belongs to the empty-first-launch state and the defensive
    // pre_drop (future-dated) branch, never here.
    const panel = DROP_FEED.slice(
      DROP_FEED.indexOf('function NoDropTodayPanel'),
      DROP_FEED.indexOf('function NoDropTodayPanel') + 2000,
    );
    expect(panel).not.toMatch(/NextDropCountdown/);
  });

  it('no-Drop banner copy carries no urgency, scarcity, or push phrasing', () => {
    const panelStart = DROP_FEED.indexOf('NoDropTodayPanel.Banner');
    const panelEnd = DROP_FEED.indexOf('data-component="NoDropTodayPanel.Cta"', panelStart);
    const banner = DROP_FEED.slice(
      panelStart,
      panelEnd > panelStart ? panelEnd : panelStart + 2000,
    );
    const forbidden = [
      'last chance',
      'running out',
      'almost gone',
      'limited',
      'miss out',
      'come back',
      'tomorrow',
      "don't miss",
    ];
    for (const bad of forbidden) {
      expect(banner.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
});

describe('DropCard — readOnly prop (P4 PR B)', () => {
  it('declares the readOnly prop on DropCardProps', () => {
    expect(DROP_CARD).toMatch(/readonly readOnly\?: boolean/);
  });

  it('hides the stance button grid when readOnly is true', () => {
    expect(DROP_CARD).toMatch(/\{readOnly \? null : \(/);
    // The grid still exists in the non-readOnly path; the pin here
    // is that the Disagree/Skip/Agree row is guarded by readOnly.
    expect(DROP_CARD).toMatch(/role="group" aria-label="Stance"/);
  });

  it('hides the stance-confirmation pill when readOnly is true', () => {
    expect(DROP_CARD).toMatch(/\{!readOnly && selected !== null \?/);
  });

  it('hides the locked-Battle CTA when readOnly is true', () => {
    // The read-only replay should not surface Battle at all — it's
    // not the user's active ritual, it's a receipt.
    expect(DROP_CARD).toMatch(/\{readOnly \? \(\s*<WhySourcesDialog/);
  });
});
