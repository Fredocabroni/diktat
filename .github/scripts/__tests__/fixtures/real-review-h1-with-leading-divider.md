---

# Brand-Voice and Taboo Audit — Diktat

**Scope:** `apps/web/**/*.tsx`, `apps/bots/**/templates/**` (no files found), `packages/ai-fabric/src/prompts/*`
**Reference documents:** `docs/X_LAUNCH_PLAN.md` §2, `docs/MASTER_PLAN.md`, `docs/ADDICTION_ARCHITECTURE.md`, `CLAUDE.md`
**Auditor:** copy-linter subagent
**Date:** 2026-06-18

---

## VIOLATIONS

### V-01 — Crypto terminology exposed to user in production UI

**File:** `apps/web/app/(app)/wallet/page.tsx:42`

**Offending text:**
```
Held as USDC, shown in USD.
```

**Rule violated:** CLAUDE.md taboo — "Never mention bitcoin, ethereum, or general crypto terminology in user-facing copy. Wallet = 'Wallet', currency = 'USDC' shown as USD." The instruction is that USDC is *the rail* users never see; this line surfaces the underlying stablecoin name to the user directly and explicitly.

**Severity:** BLOCK — This is a user-visible string, not a comment. It is rendered as a `<p>` element on the live wallet page.

**Suggested rewrite:**
```
Your balance is held securely and shown in USD.
```

---

### V-02 — "Payouts unlock at tier 3" — real-money payout mechanic named to user without AP framing

**File:** `apps/web/components/wallet/GhostEarningsCard.tsx:22`

**Offending text:**
```
What you would have earned at tier 3. Payouts unlock at tier 3.
```

**Rule violated:** MASTER_PLAN.md non-negotiable — "AP-only prediction markets … no real-money mechanics." ADDICTION_ARCHITECTURE.md §11 anti-pattern — "Dopamine loops tied to real money below tier 3." CLAUDE.md taboo — "Never add gambling-tier real-money mechanics." The word "Payouts" in a financial context on the Wallet page strongly implies real-money disbursement to a user who has not yet qualified. The second sentence ("Payouts unlock at tier 3") reads as a dangled financial reward that directly motivates grind.

**Severity:** BLOCK — This directly couples an AP mechanic to the implicit promise of financial payouts and names it as a reward for leveling up, which is the definition of a gambling-tier progression hook on real money.

**Suggested rewrite:**
```
What you would have earned at tier 3.
```
Or, if payouts are live at tier 3:
```
AP at tier 3 converts to real value.
```

---

## NEAR-MISSES AND ADVISORY CONCERNS

### A-01 — Comment vs. implementation mismatch on wallet page

**File:** `apps/web/app/(app)/wallet/page.tsx:1–4`

The developer comment block correctly states "No crypto surface language. USDC is the rail; users see 'USD'." — but the implementation on line 42 contradicts it. The comment accurately describes intent; the code violates it. See V-01.

---

### A-02 — "Ghost earnings" label (capitalized) — advisory only

**File:** `apps/web/components/wallet/GhostEarningsCard.tsx:19`

**Text:** `Ghost earnings`

ADDICTION_ARCHITECTURE.md §8 explicitly names and approves this term as "trust up (transparent)." PASS. Flagged advisory only because "ghost" is mildly Gen-Z slang against the dry editorial voice — no action required.

---

### A-03 — "Mainstream" in WhySourcesDialog — optional tightening

**File:** `apps/web/components/drop/WhySourcesDialog.tsx:56–57`

**Text:**
```
Mainstream coverage appears as framing context only — never as the truth source.
```

Compliant — used neutrally and factually, not as a partisan label. Advisory: "Mainstream" echoes political shorthand ("MSM"). Optional tighter rewrite: `News outlet coverage appears as framing context only — never as the truth source.`

---

### A-04 — Notification copy "9 PM" timing — confirmed compliant

**File:** `apps/web/app/(app)/settings/notifications/page.tsx:146–148, 156`

**Text:** `We push at most once a day, at 9 PM local, only when your streak is on the line.` / `Only fires if you haven't finished Take 5 yet. One push, at 9 PM.`

ADDICTION_ARCHITECTURE.md §3 specifies 9 PM risk push. CLAUDE.md confirms 21:00–21:14 local window. PASS.

---

### A-05 — "Stake AP on the outcome" — compliant

**File:** `apps/web/app/onboard/preview/page.tsx:51`

**Text:** `Prediction — stake AP on the outcome.`

"Stake AP" is correct per CLAUDE.md ("stakes = 'AP'"). PASS.

---

### A-06 — AI prompt "may be cited" phrasing — not a violation

**File:** `packages/ai-fabric/src/prompts/fact-check.ts:35`

**Text:** `NOT TRUTH SOURCES (may be cited only as framing, never as fact):`

Modal permission grammar in a system-prompt instruction, not epistemic hedging in user-facing copy. PASS.

---

### A-07 — No bots/templates directory found

The glob `apps/bots/**/templates/**` returned no matches. Nothing to audit. Advisory: when X-bot templates are created, ensure they pass the copy-linter before merge — particularly the AI-voice opener ban, the emoji rule, and the partisan-label-as-insult rule.

---

### A-08 — Drop-headline prompt — compliant

**File:** `packages/ai-fabric/src/prompts/drop-headline.ts`

Constraint system correctly bans editorialization, causation hedging, and hedge words. Voice guide alignment confirmed ("dry, sharp, lowercase for tonal takes"). PASS.

---

### A-09 — Drop-headline prompt missing first-person opener ban — minor gap

**File:** `packages/ai-fabric/src/prompts/drop-headline.ts:31`

The voice spec bans "AI-voice openers." The prompt does not explicitly ban first-person or greeting-style openers. In practice news headlines don't use them, but adding one line is low-cost insurance:

> *Suggested addition:* `Do not begin the headline with a greeting, an address to the reader, or first-person subject ("We", "I", "Let's").`

---

## OVERALL VERDICT

**BLOCK**

Two violations require resolution before these files are merge-eligible:

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| V-01 | `apps/web/app/(app)/wallet/page.tsx` | 42 | `"Held as USDC, shown in USD."` — crypto rail name in user-visible string | Replace with `"Your balance is held securely and shown in USD."` |
| V-02 | `apps/web/components/wallet/GhostEarningsCard.tsx` | 22 | `"Payouts unlock at tier 3."` — real-money dangled as grind incentive | Remove sentence, or rewrite as `"AP at tier 3 converts to real value."` |

All other copy across the 31 TSX files reviewed is voice-compliant: no emoji violations, no partisan-label-as-insult, no AI-voice openers, no spam notification patterns, no dark-pattern modals, no crypto terminology beyond the two violations above, and no MSM-as-truth citations in user-facing strings. The prompt contracts in `packages/ai-fabric/src/prompts/` are correctly structured and internally consistent with the brand taboo list.

