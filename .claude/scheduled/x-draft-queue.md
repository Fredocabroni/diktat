---
name: x-draft-queue
schedule: "0 20 * * *"
timezone: America/New_York
description: Generates next-day @Diktat post drafts at 8:00 PM local, ratioed by content pillars from X_LAUNCH_PLAN.md §3.
---

# x-draft-queue

## Run

1. Read pillar ratios from `docs/X_LAUNCH_PLAN.md` §3.
2. Decide tomorrow's post count based on launch phase (pre-launch: 5/day; soft: 7/day; public: 10/day). Default: 5/day until phase explicitly bumped.
3. Distribute count across pillars per ratio. Round so totals match.
4. For each post: invoke `x-draft` skill with the assigned pillar, ask for 3 variants, auto-select the variant the `copy-linter` rates highest, save to `x_posts` table with `status='pending'` and `scheduled_for = tomorrow + slot`.
5. Slot the day's posts at: 7:00 AM, 12:30 PM, 4:30 PM, 7:45 PM (Drop preview), 10:00 PM ET.
6. Compose approval email: list each draft with pillar, slot, copy. Send via Gmail MCP to fmichael@promarketvision.com.
7. Log to `SESSION_LOGS/scheduled/x-draft-queue-YYYY-MM-DD.md`.

## Skip conditions
- `x_posts` table doesn't exist yet (Phase 6 onward) → drafts saved to `SESSION_LOGS/x-drafts/` for manual review.
- Project in crisis state (per X_LAUNCH_PLAN.md §9) → skip auto-generation, email status only.
