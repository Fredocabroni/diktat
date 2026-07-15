# Diktat — Tribe Quiz Onboarding: Content & Scoring Plan

> Status: shipped design (per docs/VISION.md §3). Pure frontend — reuses the
> existing `tribes.list` + `tribes.join` APIs; no backend/migration changes. The
> quiz replaces the _content_ of `/onboard/tribe`; the flow position (welcome →
> tribe → preview) is unchanged, and the "skip" / optional-ness is preserved.
>
> **Known tuning target:** the Populist ↔ Libertarian margin is the thin edge
> (0.55) — both are low-trust and split only on the single state-power question.
> Acceptable at launch (the mandatory override makes a near-miss cheap); revisit
> from real usage.

---

## 1. Axes

Placement is derived from three shared value axes encoded in the five tribe
manifestos. **Change (C)** and **Trust (T)** are the primary discriminators —
they separate all five tribes. **State power (S)** is a tiebreaker (three of five
tribes are neutral on it), used mainly to split Libertarian vs Progressive.

| Axis                                | Role       | − pole                                   | + pole                             |
| ----------------------------------- | ---------- | ---------------------------------------- | ---------------------------------- |
| **C — Change vs continuity**        | primary    | preserve what has worked                 | replace / build fast               |
| **T — Elite & institutional trust** | primary    | suspicion of the powerful & credentialed | institutions have earned deference |
| **S — State power**                 | tiebreaker | provision through individuals & markets  | provision guaranteed collectively  |

---

## 2. Tribe coordinates

Raw on a −2..+2 scale; **normalized** = raw ÷ 2 (the target vectors the resolver
matches a user against). Slugs match the seed (migration `20260420090008`).

| Tribe (slug)                         | S   | C   | T   | Normalized (S, C, T) |
| ------------------------------------ | --- | --- | --- | -------------------- |
| Libertarian (`libertarians`)         | −2  | 0   | −1  | (−1.0, 0.0, −0.5)    |
| Progressive (`progressives`)         | +2  | +1  | +1  | (+1.0, +0.5, +0.5)   |
| Traditionalist (`traditionalists`)   | 0   | −2  | +2  | (0.0, −1.0, +1.0)    |
| Populist (`populists`)               | 0   | +1  | −2  | (0.0, +0.5, −1.0)    |
| Accelerationist (`accelerationists`) | −1  | +2  | −1  | (−0.5, +1.0, −0.5)   |

---

## 3. The questions

Content bars (non-negotiable):

- **Concrete tradeoffs, never labels.** No question asks "should the state be
  bigger/smaller" or names an ideology. A user cannot tell which tribe an answer
  maps to.
- **Every option in its strongest, most defensible form** — the version a
  thoughtful adherent would proudly claim. Zero strawmen.
- **No free-ride neutrals.** Every option is a committed position that accepts a
  real cost — never an "I'm above this" refusal that scores neutral and flatters
  the fence-sitter. (A middle option may sit near an axis's origin only if it is a
  _substantive_ stance with a cost.)
- **Viewpoint-neutral** — mirrors the AI-judge principle (VISION §7): the first
  thing a user touches cannot reveal a house lean.

Tribe names are never shown during the quiz. Axis scores (right column) are
hidden from the user.

### Q1 — Change

**"A long-standing rule or tradition is under fire — plenty of people say it no longer fits how we live now. Your honest reaction:"**

| Option                                                                                                     | Score |
| ---------------------------------------------------------------------------------------------------------- | ----- |
| A. "If it has outlived its purpose, replace it. Keeping something out of habit isn't a reason to keep it." | C +2  |
| B. "Change the parts that are clearly failing, but don't tear out what still works."                       | C 0   |
| C. "Be careful — things that have lasted this long usually solve problems we've stopped noticing."         | C −2  |

### Q2 — Trust

**"On a contested issue, the experts, officials, and major institutions have mostly lined up on one side. That makes you:"**

| Option                                                                                                                                     | Score |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| A. "Wary. When the credentialed all agree, it's usually because the system rewards agreement, not truth."                                  | T −2  |
| B. "More confident. They can be wrong, but broad agreement among people who've studied it beats a hunch."                                  | T +2  |
| C. "Trust the measurements, not the marching orders — believe them on the facts, but experts don't get to decide what we _do_ about them." | T −1  |

_(C is a committed position, not a dodge: it accepts expert facts but rejects
technocratic authority over values — which risks undervaluing expert policy
judgment.)_

### Q3 — Change

**"A breakthrough could do enormous good, but its risks are real and hard to foresee. The right pace is:"**

| Option                                                                                                | Score |
| ----------------------------------------------------------------------------------------------------- | ----- |
| A. "Move now. Get it into the world and solve problems as they arise — waiting has a body count too." | C +2  |
| B. "Move deliberately — put limits and oversight in place before it scales."                          | C +1  |
| C. "Hold back. Some doors are very hard to close once they're open."                                  | C −2  |

### Q4 — Trust

**"Ordinary people are in a standoff with a powerful, established institution, and it's honestly unclear who's right. You find yourself pulling for:"**

| Option                                                                                                                       | Score |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "The people. The institution already has the resources and the benefit of the doubt — usually more than it has earned."   | T −2  |
| B. "The institution. It carries rules and hard-won knowledge that protect everyone, not just the loudest voice in the room." | T +2  |
| C. "The institution — but hold it to its own rules. Its authority is only as good as its willingness to be checked."         | T +1  |

### Q5 — State (with a trust signal)

**"A major employer in a mid-size town shuts down, and hundreds lose their income at once. The response you'd get behind:"**

| Option                                                                                                                        | Score      |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A. "Clear the way for what's next — cut the red tape and taxes so new businesses can move in and hire."                       | S −2       |
| B. "Put a real safety net under them — retraining, benefits, direct support — so no family free-falls during the transition." | S +2, T +1 |
| C. "Rally the town itself — local employers, community groups, neighbors stepping up before any distant agency does."         | S 0        |

**Axis coverage:** C = Q1, Q3 · T = Q2, Q4, (Q5-B) · S = Q5.

---

## 4. Resolution logic

1. Sum the deltas across all answers → raw `(S, C, T)`.
2. **Normalize** by each axis's max achievable magnitude, clamped to [−1, +1]:
   `nS = clamp(S/2, -1, 1)` · `nC = clamp(C/4, -1, 1)` · `nT = clamp(T/5, -1, 1)`
3. **Weighted distance** to each tribe's normalized target (C & T primary; S is a
   half-weight tiebreaker): `d² = 0.5·ΔS² + 1.0·ΔC² + 1.0·ΔT²`
4. **Nearest target wins** → suggested tribe.
5. **Ties / low confidence:** exact tie → prefer the smaller S-distance, then a
   fixed order. If the two closest tribes are within `d²` difference < 0.15, **or**
   the user vector magnitude is tiny (mostly-neutral answers), the result opens
   directly on the all-five override view rather than a confident "You lean X".
   The override always shows every tribe, so a low-confidence result is never a
   dead end.

Join mapping: suggested tribe `slug` → look up its `id` in `tribes.list` → call
the existing `tribes.join({ tribeId })`.

---

## 5. Verification — each tribe's canonical answers resolve to itself

| Tribe           | Answers Q1–Q5 | Normalized (S, C, T) | Nearest (d²)   | Runner-up (d²) | Margin |
| --------------- | ------------- | -------------------- | -------------- | -------------- | ------ |
| Libertarian     | B, C, B, C, A | (−1.0, +0.25, 0.0)   | **Lib 0.31**   | Accel 0.94     | 0.63   |
| Progressive     | B, B, B, C, B | (+1.0, +0.25, +0.8)  | **Prog 0.15**  | Trad 2.10      | 1.95   |
| Traditionalist  | C, B, C, B, C | (0.0, −1.0, +0.8)    | **Trad 0.04**  | Prog 2.84      | 2.80   |
| Populist        | B, A, B, A, C | (0.0, +0.25, −0.8)   | **Pop 0.10**   | Lib 0.65       | 0.55   |
| Accelerationist | A, C, A, C, A | (−1.0, +1.0, 0.0)    | **Accel 0.38** | Lib 1.25       | 0.87   |

All five place correctly. **Smallest margin is Populist 0.55** (over Libertarian —
the known tuning target). No pair is close on the primary (C, T) axes; Lib↔Pop
split on both T and S, Lib↔Accel on C (change appetite), Prog↔Trad on C.

---

## 6. Result screen + override (VISION §3)

- Lead with **"You lean {Name}"** + the tribe's **manifesto** (from `tribes.list`)
  - a primary **"Join {Name}"**.
- **Mandatory override:** a clear **"Not you? Pick another"** that expands to all
  five tribes (the classic card list), plus a **"Skip"** — so no one is ever boxed
  in. (Low-confidence results open straight to this view.)
- Joining calls the **existing** `tribes.join` (no API change).

## 7. Implementation

- Questions + option scores + tribe targets + the resolver live in a pure typed
  module (`apps/web/app/onboard/tribe/quiz.ts`) — no React / no network, so the
  resolver is unit-tested against the §5 canonical-answers table.
- The page is a `useState` step machine (mirrors `login/page.tsx`); question
  transitions use the `m.*` / `useReducedMotion` motion pipeline; options render
  with `@diktat/ui`'s `ChoiceButton`.
- Copy passes the copy-linter / addiction-auditor gates; the quiz stays optional
  (skip preserved) per ADDICTION_ARCHITECTURE §11.
