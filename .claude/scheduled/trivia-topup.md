---
name: trivia-topup
schedule: "0 3 * * *"
timezone: America/New_York
description: Refills low-stock trivia categories overnight. Runs at 3:00 AM local. Inactive until Phase 3.
---

# trivia-topup

## Pre-condition
- Phase 3 shipped (trivia generation pipeline + `trivia_questions` table exist).
- Until then this scheduled task no-ops with a log entry.

## Run

1. Query Supabase: for each category, count `trivia_questions WHERE difficulty <= 5 AND status = 'approved'`.
2. For any category with `count < 50`: invoke `trivia-seed` skill with `category=<that>`, `count=25`, `band=1-5`.
3. Hard cap: never invoke `trivia-seed` for more than 4 categories per run (cost protection).
4. Log to `SESSION_LOGS/scheduled/trivia-topup-YYYY-MM-DD.md`: per-category before/after counts, AI fabric spend.
5. If total spend exceeds $5 for the run, abort remaining categories and email a warning.

## Skip conditions
- Phase 3 not shipped → log skip and exit.
- Verify gate offline → log skip and exit.
- Daily AI fabric budget already at 80% → log skip and exit.
