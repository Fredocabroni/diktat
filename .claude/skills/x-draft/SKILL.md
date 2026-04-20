---
name: x-draft
description: Use to draft a tweet for @Diktat. Reads the voice guide and content pillars, asks which pillar, returns 3 drafts for selection, saves chosen draft as pending in x_posts.
---

# x-draft

## Procedure

1. **Read source.** `docs/X_LAUNCH_PLAN.md` §2 (voice) and §3 (pillars).
2. **Confirm pillar.** Ask user which pillar this draft is for: Fact Drops · Ratio Watch · Drop Previews · Beef Feed · Changed My Mind · Product Teasers.
3. **Generate 3 drafts.** Each must:
   - Match voice guide (dry, sharp, sourced; lowercase for takes, capitals for data drops)
   - Cite source (link or screenshot reference) if Fact Drop or Ratio Watch
   - Stay within X character limits
   - Avoid the "Never" list (no AI voice, no emoji except 🔥 for milestones, no "unpopular opinion", no partisan-label-as-insult)
4. **Copy-linter gate.** Run `copy-linter` subagent on all 3 drafts. Drop any that fail.
5. **Present.** Show drafts numbered 1-3 with the source links inline.
6. **Save selection.** On user pick, insert into `x_posts` table with `status='pending'` (Phase 6 onward — until then write to `SESSION_LOGS/x-drafts/`).

## Rules
- Never schedule auto-publish. Pending only. Human approves.
- Never reference MSM as a truth source.
- Never beg for engagement.
- Never post when the project is in a crisis state (see X_LAUNCH_PLAN.md §9).
