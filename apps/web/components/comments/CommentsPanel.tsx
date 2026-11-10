// Topic discussion panel. Lives under each Drop/topic card's vote-and-
// split area. Collapsed by default; expanding reveals the composer,
// the sort toggle, and the paged comment list.
//
// Reading is open to any signed-in user. Composing + replying is gated
// on a locked stance on this topic (passed down as `userLocked`). When
// the caller has no locked stance the composer is replaced by a one-
// line notice; existing comments still render.
//
// Addiction-auditor contract:
//   - No notifications, no toasts, no like-count celebrations, no
//     "trending" badges.
//   - Neutral stance chips (same palette family as SplitBar). No
//     agree-green / disagree-red, no tribe colours.
//   - Lowercase, factual copy. No urgency, no gamification.
//   - Replies are indented ONE level; "reply to a reply" targets the
//     top-level parent (SQL also enforces this).
//   - Animations respect prefers-reduced-motion (only hover/focus
//     transitions are non-motion; the expand/collapse toggle does
//     not animate).

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { trpc } from '../../lib/trpc';
import { ReportButton } from '../report/ReportButton';

const BODY_MAX = 500;

type Sort = 'top' | 'new';

export interface CommentsPanelProps {
  readonly topicId: string;
  /** True when the caller has a locked stance on this topic. Required
   *  to compose; reading is unconditional once signed in. */
  readonly userLocked: boolean;
}

export function CommentsPanel({ topicId, userLocked }: CommentsPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<Sort>('top');

  const countQuery = trpc.comments.count.useQuery({ topicId }, { enabled: true });

  const listQuery = trpc.comments.list.useInfiniteQuery(
    { topicId, sort },
    {
      enabled: expanded,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  // Flat view of loaded comments across pages, in their server order.
  const comments = useMemo(
    () => (listQuery.data?.pages ?? []).flatMap((p) => p.items),
    [listQuery.data],
  );

  const panelId = `comments-panel-${topicId}`;
  const count = countQuery.data?.count ?? 0;

  return (
    <section
      data-component="CommentsPanel"
      data-expanded={expanded}
      className="flex flex-col gap-3 rounded-2xl border border-ink-300 bg-surface-card p-4"
    >
      <button
        type="button"
        data-component="CommentsPanel.Toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center justify-between gap-2 text-sm font-medium text-text-secondary"
      >
        <span>
          comments <span className="text-text-tertiary">· {count}</span>
        </span>
        <span aria-hidden className="text-text-tertiary">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded ? (
        <div id={panelId} className="flex flex-col gap-4">
          <SortToggle sort={sort} onChange={setSort} />
          {userLocked ? (
            <Composer
              topicId={topicId}
              parentId={null}
              onPosted={() => {
                void countQuery.refetch();
                void listQuery.refetch();
              }}
            />
          ) : (
            <p
              role="note"
              data-component="CommentsPanel.LockedNotice"
              className="rounded-xl border border-ink-300 bg-surface-raised px-3 py-2 text-sm text-text-secondary"
            >
              lock in a vote to comment
            </p>
          )}

          {listQuery.isLoading ? (
            <p className="text-sm text-text-tertiary">loading.</p>
          ) : comments.length === 0 ? (
            <p className="text-sm text-text-tertiary">no comments yet.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {comments.map((c) => (
                <li key={c.id}>
                  <CommentRow
                    comment={c}
                    topicId={topicId}
                    userLocked={userLocked}
                    onChanged={() => {
                      void countQuery.refetch();
                      void listQuery.refetch();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}

          {listQuery.hasNextPage ? (
            <button
              type="button"
              data-component="CommentsPanel.LoadMore"
              onClick={() => void listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
              className="self-start text-xs text-text-tertiary underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {listQuery.isFetchingNextPage ? 'loading.' : 'load more'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sort toggle

function SortToggle({
  sort,
  onChange,
}: {
  readonly sort: Sort;
  readonly onChange: (s: Sort) => void;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="comment sort"
      data-component="CommentsPanel.SortToggle"
      className="flex gap-2 text-xs"
    >
      {(['top', 'new'] as const).map((s) => {
        const active = s === sort;
        return (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s)}
            className={`rounded-full border px-3 py-1 ${
              active ? 'border-brand-accent text-brand-accent' : 'border-ink-300 text-text-tertiary'
            }`}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer

interface ComposerProps {
  readonly topicId: string;
  readonly parentId: string | null;
  readonly onPosted: () => void;
  /** When present, the composer renders in reply mode with a Cancel
   *  button that calls this. */
  readonly onCancel?: () => void;
}

function Composer({ topicId, parentId, onPosted, onCancel }: ComposerProps): React.JSX.Element {
  const [body, setBody] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const create = trpc.comments.create.useMutation();
  const trimmed = body.trim();
  const over = body.length > BODY_MAX;
  const canPost = trimmed.length > 0 && !over && !create.isPending;

  async function onPost(): Promise<void> {
    if (!canPost) return;
    setErrorMsg(null);
    try {
      await create.mutateAsync({ topicId, parentId, body: trimmed });
      setBody('');
      onPosted();
      onCancel?.();
    } catch (err) {
      // Map a handful of known codes to steady, factual copy. The
      // server wires every error path to a static tRPC message so we
      // don't echo raw PG text here either.
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('too many')) {
        setErrorMsg('slow down. try again in a minute.');
      } else if (msg.toLowerCase().includes('lock in')) {
        setErrorMsg('lock in a vote to comment');
      } else {
        setErrorMsg("couldn't post. try again.");
      }
    }
  }

  return (
    <div
      data-component="CommentsPanel.Composer"
      data-parent={parentId ?? 'top'}
      className="flex flex-col gap-2"
    >
      <label className="sr-only" htmlFor={`comment-body-${topicId}-${parentId ?? 'top'}`}>
        comment
      </label>
      <textarea
        id={`comment-body-${topicId}-${parentId ?? 'top'}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={parentId ? 'write a reply.' : 'add a comment.'}
        rows={3}
        maxLength={BODY_MAX + 50}
        className="rounded-xl border border-ink-300 bg-surface-raised px-3 py-2 text-sm text-text-primary"
      />
      <div className="flex items-center justify-between gap-2 text-xs text-text-tertiary">
        <span data-component="CommentsPanel.Counter" data-over={over}>
          {body.length}/{BODY_MAX}
        </span>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={create.isPending}
              className="rounded-full border border-ink-300 px-3 py-1 text-xs text-text-tertiary disabled:cursor-not-allowed disabled:opacity-60"
            >
              cancel
            </button>
          ) : null}
          <button
            type="button"
            data-component="CommentsPanel.PostButton"
            onClick={onPost}
            disabled={!canPost}
            className="rounded-full bg-brand-accent px-3 py-1 text-xs font-semibold text-brand-accent-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {create.isPending ? 'posting.' : 'post'}
          </button>
        </div>
      </div>
      {errorMsg ? (
        <p role="status" aria-live="polite" className="text-xs text-danger">
          {errorMsg}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment row

interface ListItem {
  readonly id: string;
  readonly topicId: string;
  readonly parentId: string | null;
  readonly handle: string;
  readonly stance: 'agree' | 'disagree';
  readonly body: string;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly likeCount: number;
  readonly likedByMe: boolean;
  readonly isMine: boolean;
  readonly replies?: ReadonlyArray<ListItem>;
  readonly replyCount?: number;
}

function CommentRow({
  comment,
  topicId,
  userLocked,
  onChanged,
}: {
  readonly comment: ListItem;
  readonly topicId: string;
  readonly userLocked: boolean;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [replying, setReplying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllReplies, setShowAllReplies] = useState(false);

  const toggleLike = trpc.comments.toggleLike.useMutation();
  const del = trpc.comments.delete.useMutation();

  // Optimistic like state. We flip locally before awaiting, and roll
  // back on failure.
  const [likedByMe, setLikedByMe] = useState(comment.likedByMe);
  const [likeCount, setLikeCount] = useState(comment.likeCount);
  useEffect(() => {
    setLikedByMe(comment.likedByMe);
    setLikeCount(comment.likeCount);
  }, [comment.likedByMe, comment.likeCount]);

  const onLikeClick = useCallback(async (): Promise<void> => {
    if (comment.deleted) return;
    const prevLiked = likedByMe;
    const prevCount = likeCount;
    setLikedByMe(!prevLiked);
    setLikeCount(prevCount + (prevLiked ? -1 : 1));
    try {
      const r = await toggleLike.mutateAsync({ commentId: comment.id });
      setLikedByMe(r.liked);
      setLikeCount(r.likeCount);
    } catch {
      setLikedByMe(prevLiked);
      setLikeCount(prevCount);
    }
  }, [comment.deleted, comment.id, likeCount, likedByMe, toggleLike]);

  // Replies list. Inline previews come from the parent list; a tap on
  // "view N more" fetches the full list.
  const inlineReplies = comment.replies ?? [];
  const replyCount = comment.replyCount ?? inlineReplies.length;
  const moreReplies = Math.max(replyCount - inlineReplies.length, 0);

  const repliesQuery = trpc.comments.listReplies.useInfiniteQuery(
    { commentId: comment.id },
    {
      enabled: showAllReplies,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const fullReplies = useMemo(
    () => (repliesQuery.data?.pages ?? []).flatMap((p) => p.items),
    [repliesQuery.data],
  );

  const shownReplies = showAllReplies && repliesQuery.data ? fullReplies : inlineReplies;

  async function onDelete(): Promise<void> {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await del.mutateAsync({ commentId: comment.id });
      onChanged();
    } finally {
      setConfirmDelete(false);
      setMenuOpen(false);
    }
  }

  return (
    <article
      data-component="CommentsPanel.Row"
      data-id={comment.id}
      data-deleted={comment.deleted}
      className="flex flex-col gap-2 rounded-xl border border-ink-300 bg-surface-raised p-3"
    >
      <header className="flex items-center gap-2 text-xs text-text-tertiary">
        <span className="font-medium text-text-secondary">{comment.handle}</span>
        <StanceChip stance={comment.stance} />
        <RelativeTime iso={comment.createdAt} />
        <div className="ml-auto">
          <OverflowMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((v) => !v)}
            isMine={comment.isMine && !comment.deleted}
            confirmDelete={confirmDelete}
            onDelete={onDelete}
            reportSlot={
              comment.isMine || comment.deleted ? null : (
                <ReportButton targetType="comment" targetId={comment.id} />
              )
            }
          />
        </div>
      </header>

      <p
        data-component="CommentsPanel.Body"
        className={
          comment.deleted ? 'text-sm italic text-text-tertiary' : 'text-sm text-text-primary'
        }
      >
        {comment.deleted ? 'deleted' : comment.body}
      </p>

      {!comment.deleted ? (
        <footer className="flex items-center gap-3 text-xs">
          <button
            type="button"
            data-component="CommentsPanel.LikeButton"
            aria-pressed={likedByMe}
            aria-label={likedByMe ? 'unlike comment' : 'like comment'}
            onClick={() => void onLikeClick()}
            className={`rounded-full border px-2 py-0.5 ${
              likedByMe
                ? 'border-brand-accent text-brand-accent'
                : 'border-ink-300 text-text-tertiary'
            }`}
          >
            <span aria-hidden>♡</span> {likeCount}
          </button>
          {userLocked && comment.parentId === null ? (
            <button
              type="button"
              data-component="CommentsPanel.ReplyButton"
              onClick={() => setReplying((v) => !v)}
              className="text-text-tertiary underline underline-offset-2"
            >
              reply
            </button>
          ) : null}
        </footer>
      ) : null}

      {replying ? (
        <Composer
          topicId={topicId}
          parentId={comment.id}
          onPosted={onChanged}
          onCancel={() => setReplying(false)}
        />
      ) : null}

      {shownReplies.length > 0 ? (
        <ul
          data-component="CommentsPanel.Replies"
          className="mt-1 flex flex-col gap-2 border-l border-ink-300 pl-3"
        >
          {shownReplies.map((r) => (
            <li key={r.id}>
              <ReplyRow
                reply={r as ListItem}
                parentId={comment.id}
                topicId={topicId}
                userLocked={userLocked}
                onChanged={onChanged}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {moreReplies > 0 && !showAllReplies ? (
        <button
          type="button"
          data-component="CommentsPanel.ViewMoreReplies"
          onClick={() => setShowAllReplies(true)}
          className="self-start text-xs text-text-tertiary underline underline-offset-2"
        >
          view {moreReplies} more {moreReplies === 1 ? 'reply' : 'replies'}
        </button>
      ) : null}

      {showAllReplies && repliesQuery.hasNextPage ? (
        <button
          type="button"
          onClick={() => void repliesQuery.fetchNextPage()}
          disabled={repliesQuery.isFetchingNextPage}
          className="self-start text-xs text-text-tertiary underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {repliesQuery.isFetchingNextPage ? 'loading.' : 'load more replies'}
        </button>
      ) : null}
    </article>
  );
}

// Reply rows reuse CommentRow's internal visual bones but never render
// a nested replies list themselves (one level only).
function ReplyRow({
  reply,
  parentId,
  topicId,
  userLocked,
  onChanged,
}: {
  readonly reply: ListItem;
  readonly parentId: string;
  readonly topicId: string;
  readonly userLocked: boolean;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleLike = trpc.comments.toggleLike.useMutation();
  const del = trpc.comments.delete.useMutation();
  const [likedByMe, setLikedByMe] = useState(reply.likedByMe);
  const [likeCount, setLikeCount] = useState(reply.likeCount);
  const [replying, setReplying] = useState(false);
  useEffect(() => {
    setLikedByMe(reply.likedByMe);
    setLikeCount(reply.likeCount);
  }, [reply.likedByMe, reply.likeCount]);

  async function onDelete(): Promise<void> {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await del.mutateAsync({ commentId: reply.id });
      onChanged();
    } finally {
      setConfirmDelete(false);
      setMenuOpen(false);
    }
  }

  async function onLikeClick(): Promise<void> {
    if (reply.deleted) return;
    const prev = likedByMe;
    const prevCount = likeCount;
    setLikedByMe(!prev);
    setLikeCount(prevCount + (prev ? -1 : 1));
    try {
      const r = await toggleLike.mutateAsync({ commentId: reply.id });
      setLikedByMe(r.liked);
      setLikeCount(r.likeCount);
    } catch {
      setLikedByMe(prev);
      setLikeCount(prevCount);
    }
  }

  return (
    <article
      data-component="CommentsPanel.Reply"
      data-id={reply.id}
      data-deleted={reply.deleted}
      className="flex flex-col gap-1"
    >
      <header className="flex items-center gap-2 text-xs text-text-tertiary">
        <span className="font-medium text-text-secondary">{reply.handle}</span>
        <StanceChip stance={reply.stance} />
        <RelativeTime iso={reply.createdAt} />
        <div className="ml-auto">
          <OverflowMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((v) => !v)}
            isMine={reply.isMine && !reply.deleted}
            confirmDelete={confirmDelete}
            onDelete={onDelete}
            reportSlot={
              reply.isMine || reply.deleted ? null : (
                <ReportButton targetType="comment" targetId={reply.id} />
              )
            }
          />
        </div>
      </header>
      <p
        data-component="CommentsPanel.Body"
        className={
          reply.deleted ? 'text-sm italic text-text-tertiary' : 'text-sm text-text-primary'
        }
      >
        {reply.deleted ? 'deleted' : reply.body}
      </p>
      {!reply.deleted ? (
        <footer className="flex items-center gap-3 text-xs">
          <button
            type="button"
            data-component="CommentsPanel.LikeButton"
            aria-pressed={likedByMe}
            aria-label={likedByMe ? 'unlike reply' : 'like reply'}
            onClick={() => void onLikeClick()}
            className={`rounded-full border px-2 py-0.5 ${
              likedByMe
                ? 'border-brand-accent text-brand-accent'
                : 'border-ink-300 text-text-tertiary'
            }`}
          >
            <span aria-hidden>♡</span> {likeCount}
          </button>
          {userLocked ? (
            <button
              type="button"
              data-component="CommentsPanel.ReplyButton"
              onClick={() => setReplying((v) => !v)}
              className="text-text-tertiary underline underline-offset-2"
            >
              reply
            </button>
          ) : null}
        </footer>
      ) : null}
      {replying ? (
        <Composer
          topicId={topicId}
          parentId={parentId}
          onPosted={onChanged}
          onCancel={() => setReplying(false)}
        />
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Overflow menu (report + delete)

function OverflowMenu({
  open,
  onToggle,
  isMine,
  confirmDelete,
  onDelete,
  reportSlot,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly isMine: boolean;
  readonly confirmDelete: boolean;
  readonly onDelete: () => void;
  readonly reportSlot: React.ReactNode;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  if (!isMine && reportSlot === null) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-component="CommentsPanel.OverflowToggle"
        aria-expanded={open}
        aria-label="more"
        onClick={onToggle}
        className="rounded-full border border-ink-300 px-2 py-0.5 text-text-tertiary"
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          data-component="CommentsPanel.OverflowMenu"
          className="absolute right-0 top-full z-10 mt-1 flex min-w-32 flex-col gap-1 rounded-xl border border-ink-300 bg-surface-card p-1 text-xs"
        >
          {reportSlot}
          {isMine ? (
            <button
              type="button"
              role="menuitem"
              data-component="CommentsPanel.DeleteButton"
              onClick={onDelete}
              className="rounded-md px-2 py-1 text-left text-danger"
            >
              {confirmDelete ? 'tap again to delete' : 'delete'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stance chip. Neutral palette — same surface token the SplitBar uses
// so a glance at the row doesn't reinforce the agree/disagree binary
// with colour. The label itself carries the stance.

function StanceChip({ stance }: { readonly stance: 'agree' | 'disagree' }): React.JSX.Element {
  const label = stance === 'agree' ? 'agrees' : 'disagrees';
  return (
    <span
      data-component="CommentsPanel.StanceChip"
      data-stance={stance}
      className="rounded-full border border-ink-300 bg-surface-raised px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary"
    >
      {label}
    </span>
  );
}

function RelativeTime({ iso }: { readonly iso: string }): React.JSX.Element {
  const text = useMemo(() => formatRelative(iso), [iso]);
  return (
    <time dateTime={iso} data-component="CommentsPanel.Time" className="text-text-tertiary">
      {text}
    </time>
  );
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(Math.floor((now - then) / 1000), 0);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const wks = Math.floor(days / 7);
  if (wks < 5) return `${wks}w`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${mos}mo`;
  return `${Math.floor(days / 365)}y`;
}
