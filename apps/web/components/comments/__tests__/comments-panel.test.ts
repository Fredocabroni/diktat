// Source-level pins for the CommentsPanel discussion UI. vitest.config
// scopes the web suite to node env; React is not rendered here. We
// assert the structural invariants the end-to-end behaviour depends on
// — gating, optimistic update shape, neutral stance palette, delete
// confirmation, reply-to-reply targeting, sort switching.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../CommentsPanel.tsx', import.meta.url), 'utf8');

describe('CommentsPanel — source invariants', () => {
  it('collapsed by default; toggle flips expanded state', () => {
    expect(SRC).toMatch(/useState\(false\)/);
    expect(SRC).toMatch(/data-component="CommentsPanel\.Toggle"/);
    expect(SRC).toMatch(/aria-expanded=\{expanded\}/);
  });

  it('composer is gated on userLocked; replaced with the locked notice when absent', () => {
    // Pin the gate expression and the sibling locked-notice presence.
    expect(SRC).toMatch(/userLocked\s*\?\s*\(?/);
    expect(SRC).toMatch(/<Composer[\s\S]{0,200}topicId=\{topicId\}/);
    expect(SRC).toMatch(/data-component="CommentsPanel\.LockedNotice"/);
    expect(SRC).toContain('lock in a vote to comment');
  });

  it('live counter + 0/500 cap; post button disabled on empty / over-limit / pending', () => {
    expect(SRC).toMatch(/const BODY_MAX = 500/);
    expect(SRC).toMatch(/const over = body\.length > BODY_MAX/);
    expect(SRC).toMatch(/const canPost = trimmed\.length > 0 && !over && !create\.isPending/);
    expect(SRC).toMatch(/disabled=\{!canPost\}/);
  });

  it('rate-limit error maps to "slow down. try again in a minute."', () => {
    expect(SRC).toContain('slow down. try again in a minute.');
  });

  it('stance chip is neutral — no red/green, no tribe tokens', () => {
    const chip = SRC.match(/function StanceChip[\s\S]*?^}/m);
    expect(chip).not.toBeNull();
    const body = chip![0]!;
    // Neutral surface + ink border only; the label does the semantic work.
    expect(body).toMatch(/border-ink-300/);
    expect(body).toMatch(/bg-surface-raised/);
    // Hard negatives: no success/danger/tribe tokens on the chip.
    for (const bad of [
      'bg-success',
      'text-success',
      'bg-danger',
      'text-danger',
      'border-success',
      'border-danger',
      'tribe-',
    ]) {
      expect(body).not.toContain(bad);
    }
  });

  it('like toggle is optimistic — flips local state before the mutation', () => {
    expect(SRC).toMatch(/setLikedByMe\(!prevLiked\)/);
    expect(SRC).toMatch(/setLikeCount\(prevCount \+ \(prevLiked \? -1 : 1\)\)/);
    // Rollback on failure.
    expect(SRC).toMatch(/catch \{\s*setLikedByMe\(prevLiked\);\s*setLikeCount\(prevCount\);/);
  });

  it('like / reply affordances never render on deleted comments', () => {
    expect(SRC).toMatch(/\{!comment\.deleted \? \(/);
    expect(SRC).toMatch(/\{!reply\.deleted \? \(/);
  });

  it('delete has a confirm step ("tap again to delete") before the mutation fires', () => {
    expect(SRC).toMatch(/if \(!confirmDelete\) \{\s*setConfirmDelete\(true\);\s*return/);
    expect(SRC).toContain('tap again to delete');
  });

  it('report path uses the existing ReportButton with target_type=comment', () => {
    expect(SRC).toMatch(/from '\.\.\/report\/ReportButton'/);
    expect(SRC).toMatch(/<ReportButton targetType="comment" targetId=\{comment\.id\}/);
    expect(SRC).toMatch(/<ReportButton targetType="comment" targetId=\{reply\.id\}/);
  });

  it('reply-to-reply targets the top-level parent (parentId = comment.id, not reply.id)', () => {
    // The ReplyRow composer is constructed with `parentId={parentId}`
    // where parentId is the enclosing top-level comment's id.
    expect(SRC).toMatch(/<ReplyRow[\s\S]*?parentId=\{comment\.id\}/);
    expect(SRC).toMatch(/readonly parentId: string;/);
    // The composer in ReplyRow uses that parentId, NOT reply.id.
    const replyIdx = SRC.indexOf('function ReplyRow(');
    expect(replyIdx).toBeGreaterThan(-1);
    const replyBody = SRC.slice(replyIdx);
    expect(replyBody).toMatch(/parentId=\{parentId\}/);
    expect(replyBody).not.toMatch(/parentId=\{reply\.id\}/);
  });

  it('sort tabs: top | new, aria-selected reflects state', () => {
    expect(SRC).toMatch(/\['top', 'new'\] as const/);
    expect(SRC).toMatch(/aria-selected=\{active\}/);
    expect(SRC).toMatch(/role="tab"/);
  });

  it('sort switch triggers a refetch via useInfiniteQuery dependency on sort', () => {
    // The list query is keyed on { topicId, sort } — React Query
    // refetches when the key changes.
    expect(SRC).toMatch(/trpc\.comments\.list\.useInfiniteQuery\(\s*\{\s*topicId,\s*sort\s*\}/);
  });

  it('"load more" is cursor-paginated via nextCursor', () => {
    expect(SRC).toMatch(/getNextPageParam: \(last\) => last\.nextCursor \?\? undefined/);
    expect(SRC).toMatch(/data-component="CommentsPanel\.LoadMore"/);
    expect(SRC).toMatch(/listQuery\.fetchNextPage\(\)/);
  });

  it('inline replies show first 3; "view N more replies" expands via listReplies', () => {
    expect(SRC).toMatch(/moreReplies > 0 && !showAllReplies/);
    expect(SRC).toMatch(/trpc\.comments\.listReplies\.useInfiniteQuery\(/);
    expect(SRC).toMatch(/data-component="CommentsPanel\.ViewMoreReplies"/);
  });

  it('refuses engagement anti-patterns: no confetti, trending badges, like-celebration copy', () => {
    // Scope to the component return bodies — the leading block comment
    // legitimately mentions `trending` as something the UI must NOT
    // surface, and the forbidden-token check cannot false-positive on
    // its own guard-rail.
    const bodyStart = SRC.indexOf("'use client'");
    expect(bodyStart).toBeGreaterThan(-1);
    const body = SRC.slice(bodyStart);
    const forbidden = [
      'confetti',
      '🎉',
      '🔥',
      '🏆',
      'trending',
      'Trending',
      'HOT',
      'nice!',
      'Nice!',
      'awesome',
      'congrats',
      'streak',
    ];
    for (const bad of forbidden) {
      expect(body).not.toContain(bad);
    }
  });

  it('keyboard reachable: the toggle is a <button>, controls carry labels', () => {
    expect(SRC).toMatch(
      /<button\s+type="button"[\s\S]{0,200}data-component="CommentsPanel\.Toggle"/,
    );
    expect(SRC).toMatch(/aria-label=\{likedByMe \? 'unlike comment' : 'like comment'\}/);
    expect(SRC).toMatch(/aria-label="more"/);
  });

  it('respects prefers-reduced-motion: no transition classes on the expand container', () => {
    // The expand container is a plain `<div>` with no `transition-*`
    // classes. Any new motion must be behind a motion-safe: prefix.
    const expandContainer = SRC.match(/\{expanded \? \(\s*\n\s*<div id=\{panelId\}[^>]*>/);
    expect(expandContainer).not.toBeNull();
    expect(expandContainer![0]!).not.toMatch(/transition-/);
    expect(expandContainer![0]!).not.toMatch(/animate-/);
  });
});

// ---------------------------------------------------------------------------
// ReportButton + Comments router registration pins.
// ---------------------------------------------------------------------------

describe('ReportButton — target type extended to comment', () => {
  it('accepts target_type="comment"', () => {
    const btnSrc = readFileSync(new URL('../../report/ReportButton.tsx', import.meta.url), 'utf8');
    expect(btnSrc).toMatch(
      /targetType:\s*'debate_arg'\s*\|\s*'drop'\s*\|\s*'user'\s*\|\s*'comment'/,
    );
  });
});
