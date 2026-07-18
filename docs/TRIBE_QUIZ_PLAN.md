# Diktat — Tribe Quiz Onboarding: Content & Scoring Plan

> Status: shipped design (per docs/VISION.md §3). Pure frontend — reuses the
> existing `tribes.list` + `tribes.join` APIs; no backend/migration changes. The
> quiz replaces the _content_ of `/onboard/tribe`; the flow position (welcome →
> tribe → preview) is unchanged, and the "skip" / optional-ness is preserved.
>
> **Rev 5 (2026-07-17):** length + punctuation pass over the rev 4 set. Each
> scene is cut to one punchy line, each option to one tight sentence (manifesto
> length), and em-dashes are stripped from all user-facing copy (house style).
> Scenes, scores, and axis assignments are unchanged from rev 4 — this is a copy
> pass, not a redesign, so §4/§5 and the resolver tests are untouched. (Q13-B was
> also rewritten from a process-dunk into a positive accelerationist claim; score
> unchanged at T +1.)
>
> **Rev 4 (2026-07-17):** v2 voice rewrite — 13 scene-driven questions (4 Change /
> 5 Trust / 4 State), each a specific situation with stakes in the manifesto
> register. Supersedes the v1 five-question set. Q13 (tech-elite fault line) is a
> deliberate 13th, added to sharpen real-user placement on the Populist↔
> Accelerationist boundary (see §5).
>
> **Tightest pair — Populist ↔ Accelerationist, `d² = 0.625`. This is the
> GEOMETRIC MAXIMUM, not a tuning target.** The two tribes' normalized _corners_
> are only 0.625 apart in the weighted metric, so a perfectly canonical answerer
> lands exactly on its corner and is 0.625 from the neighbour — no volume of
> questions can beat that ceiling (see §5). It is documented, not "to be improved."
> The mandatory override makes a near-miss cheap.
>
> **Model-level open question (post-launch, NOT a pre-launch tuning item):** that
> Populist and Accelerationist sit only 0.625 apart suggests the 3-axis model may
> be _compressing_ a distinction that is large in the real world — grievance /
> restoration (take it back from the insiders) vs techno-futurism (build the
> frontier). Both read as "change-positive, trust-negative" in (C, T) space, but
> they are different animals. Whether to pull those corners apart is a
> **coordinates / manifesto** decision — revisit only after real users show us
> whether the placements feel right. Do not fix it by re-scoring questions.

---

## 1. Axes

Placement is derived from three shared value axes encoded in the five tribe
manifestos. **Change (C)** and **Trust (T)** are the primary discriminators —
they separate all five tribes and carry full weight. **State power (S)** is a
half-weight tiebreaker (three of five tribes are neutral on it).

| Axis                                | Role       | − pole                                   | + pole                             |
| ----------------------------------- | ---------- | ---------------------------------------- | ---------------------------------- |
| **C — Change vs continuity**        | primary    | preserve what has worked                 | replace / build fast               |
| **T — Elite & institutional trust** | primary    | suspicion of the powerful & credentialed | institutions have earned deference |
| **S — State power**                 | tiebreaker | provision through individuals & markets  | provision guaranteed collectively  |

> **Axis hygiene (rev 4 fix):** the T axis measures _deference to institutions &
> elites_, **not** appetite for state power. "The rule of law should protect the
> individual from an overreaching state" is an **S-axis** sentiment (limit state
> power) — it must never be scored as T-distrust. Q8 was corrected for exactly
> this leak: its libertarian option now earns its `T−1` from distrust of the
> _officials_ while affirming the _framework_, with the anti-state-power framing
> removed.

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
  bigger/smaller" or names an ideology. Every question drops the user into a
  specific scene with stakes; a user cannot tell which tribe an answer maps to.
- **Every option in its strongest, most defensible form** — the version a
  thoughtful adherent would proudly claim. Zero strawmen.
- **No free-ride neutrals.** Every option is a committed position that accepts a
  real cost — never an "I'm above this" refusal that scores neutral and flatters
  the fence-sitter. (A middle option may sit near an axis's origin only if it is a
  _substantive_ stance with a cost.)
- **Viewpoint-neutral** — mirrors the AI-judge principle (VISION §7): the first
  thing a user touches cannot reveal a house lean.
- **One-line scenes, one-sentence options, no em-dashes** (rev 5, house style).

Tribe names are never shown during the quiz. Axis scores (right column) are
hidden from the user. Option order is A, B, C — the §5 canonical keys and the
resolver test address options by that index, so the order is load-bearing.

### Q1 — Change

**"Your town's volunteer fire company runs on trust and handshakes. The state says certify or shut down."**

| Option                                                                   | Score |
| ------------------------------------------------------------------------ | ----- |
| A. "Certify it. 'We've always done it this way' never put out a fire."   | C +2  |
| B. "Keep the company, add the standards that save lives."                | C 0   |
| C. "Hands off. Kill the trust that runs it and nobody answers the call." | C −2  |

### Q2 — Trust

**"The agencies reversed a decade of official guidance overnight, with all the certainty they had before."**

| Option                                                                  | Score |
| ----------------------------------------------------------------------- | ----- |
| A. "That's a guild protecting its authority, not the evidence talking." | T −2  |
| B. "That's the process working. They moved when the data moved."        | T +2  |
| C. "Take the finding. Skip the orders about what to do with it."        | T −1  |

_(C is a committed position, not a dodge: it accepts expert facts but rejects
technocratic authority over values — which risks undervaluing expert policy
judgment.)_

### Q3 — Change

**"Your town's hundred-year-old high school graduates a third of its seniors barely able to read."**

| Option                                                                      | Score |
| --------------------------------------------------------------------------- | ----- |
| A. "Replace it. A century of tradition doesn't buy one more failing class." | C +2  |
| B. "Overhaul it. New leadership, hard accountability, same school."         | C +1  |
| C. "The school isn't the disease. Rebuild what collapsed around it."        | C −2  |

### Q4 — Trust

**"A family sues the hospital three towns depend on. Botched surgery, or every protocol followed. Nobody knows."**

| Option                                                          | Score |
| --------------------------------------------------------------- | ----- |
| A. "The family. Institutions bury their mistakes for a living." | T −2  |
| B. "The hospital. One family's grief isn't evidence."           | T +2  |
| C. "The hospital, if it opens every record to be checked."      | T +1  |

### Q5 — State

**"The town's biggest employer shuts down overnight. Hundreds lose their paycheck."**

| Option                                                               | Score |
| -------------------------------------------------------------------- | ----- |
| A. "Cut the taxes and red tape so new employers move in."            | S −2  |
| B. "Put a floor under them. Retraining, benefits, direct support."   | S +2  |
| C. "Rally the town. Local business and neighbors before any agency." | S 0   |

### Q6 — Change

**"A new technology could save thousands of lives and carries risks nobody can map."**

| Option                                                  | Score |
| ------------------------------------------------------- | ----- |
| A. "Ship it. Delay has a body count too."               | C +2  |
| B. "Move, but lock in the guardrails before it scales." | C 0   |
| C. "Slow down. Some doors don't close once they open."  | C −2  |

### Q7 — State

**"A working family can't cover a hospital bill that would wipe out a year's savings."**

| Option                                                                          | Score |
| ------------------------------------------------------------------------------- | ----- |
| A. "Guarantee it. Some needs are too basic to price."                           | S +2  |
| B. "Open the market so care costs what it should, not what the cartel charges." | S −2  |
| C. "Mutual aid. Community funds, people covering their own."                    | S 0   |

### Q8 — Trust

**"A guilty man walks free. Police skipped a warrant, so the evidence is thrown out."**

| Option                                                                               | Score |
| ------------------------------------------------------------------------------------ | ----- |
| A. "Good. Trust the rule precisely because you can't trust the people enforcing it." | T −1  |
| B. "A guilty man walks and the victim eats it. The rules shield insiders."           | T −2  |
| C. "The law has to hold even when it stings."                                        | T +2  |

_(Rev 4 rescore: A previously smuggled an anti-state-power sentiment into a
T-distrust score. It now earns `T−1` honestly — distrust of the officials, trust
in the framework — with no S-axis leak. A vs B remains the Libertarian↔Populist
splitter.)_

### Q9 — State

**"No company will wire the rural county. Kids do their homework in parking lots."**

| Option                                                            | Score |
| ----------------------------------------------------------------- | ----- |
| A. "Public build. The market already looked and walked away."     | S +2  |
| B. "Clear the permits and let a company find the profit."         | S −2  |
| C. "Let the towns wire themselves. Co-ops, neighbors pooling in." | S 0   |

### Q10 — State

**"Your neighbor's been on public support three years. Lifeline, or a trap that pays him to stay stuck."**

| Option                                                               | Score |
| -------------------------------------------------------------------- | ----- |
| A. "Fund it. Letting people drown to motivate them is just cruelty." | S +2  |
| B. "Shrink it to a floor. Help you lean on forever becomes a cage."  | S −2  |
| C. "Tie it to the community. Work he can do, people who know him."   | S 0   |

### Q11 — Trust

**"The one institution you always defended did something indefensible and buried it. It comes out."**

| Option                                                                              | Score |
| ----------------------------------------------------------------------------------- | ----- |
| A. "Done. If even that one hid its rot, they all run on PR."                        | T −2  |
| B. "One betrayal doesn't erase what it earned. Hold it to account, don't torch it." | T +2  |
| C. "Proof nothing gets a permanent pass. Audit it harder now."                      | T −1  |

### Q12 — Change

**"Your city can bet its whole budget on leveling downtown and building new, or keep patching what's there."**

| Option                                                                  | Score |
| ----------------------------------------------------------------------- | ----- |
| A. "Swing big. Cities that only patch decay in slow motion."            | C +2  |
| B. "One bold project it can afford to lose, not the whole treasury."    | C 0   |
| C. "Patch and maintain. Don't stake the city on an untested blueprint." | C −2  |

_(Rev 4 replacement: the cut Q12 measured personal risk tolerance and mis-scored
it on the Change axis. This is a **public** decision with **public** stakes —
same swing-vs-caution energy, correct construct.)_

### Q13 — Trust _(Populist ↔ Accelerationist fault line)_

**"A founder nobody elected controls the tools half the country runs on. And it works."**

| Option                                                                           | Score |
| -------------------------------------------------------------------------------- | ----- |
| A. "A king is a king, whether the crown is a server farm."                       | T −2  |
| B. "Good. Whoever builds the future has earned the right to run it."             | T +1  |
| C. "Fine, until you can't switch off his tools without switching off your life." | T −1  |

_(Populist reads the builder as another insider (A, `T−2`); Accelerationist
grants him legitimacy for building (B, `T+1`, a positive claim after the rev 5
rewrite — no longer a dunk on process); the middle is a contestability/exit
stance (C, `T−1`). This is the one question that pulls the tightest pair apart on
the T axis — see §5. It does not raise the geometric ceiling; it reduces
mis-placement of noisy real users on that boundary.)_

**Axis coverage:** C = Q1, Q3, Q6, Q12 · T = Q2, Q4, Q8, Q11, Q13 · S = Q5, Q7, Q9, Q10.

---

## 4. Resolution logic

1. Sum the deltas across all answers → raw `(S, C, T)`.
2. **Normalize** by each axis's max achievable magnitude, clamped to [−1, +1].
   Max magnitude = (questions on that axis) × 2: **S = 8** (4 Qs), **C = 8**
   (4 Qs), **T = 10** (5 Qs).
   `nS = clamp(S/8, −1, 1)` · `nC = clamp(C/8, −1, 1)` · `nT = clamp(T/10, −1, 1)`
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

Canonical answer keys (Q1–Q13) and the vector they produce:

| Tribe           | Q1–Q13 answers                | Normalized (S, C, T) |
| --------------- | ----------------------------- | -------------------- |
| Libertarian     | B C A C · A B B A B B · C C C | (−1.0, 0.0, −0.3)    |
| Progressive     | B B B C · B B A A A A · B A A | (+1.0, +0.375, +0.2) |
| Traditionalist  | C B C B · C C C C C C · B C A | (0.0, −1.0, +0.6)    |
| Populist        | A A A A · C B C B C C · A B A | (0.0, +0.5, −1.0)    |
| Accelerationist | A A A C · A A B A C C · C A B | (−0.5, +1.0, −0.2)   |

_(Answer order runs Q1–Q13; the middot groups are only for reading.)_

Resolution against the §2 targets (`d² = 0.5·ΔS² + ΔC² + ΔT²`):

| Tribe           | Nearest (d²)   | Runner-up (d²) | Margin |
| --------------- | -------------- | -------------- | ------ |
| Libertarian     | **Lib 0.04**   | Accel 1.17     | 1.13   |
| Progressive     | **Prog 0.11**  | Pop 1.96       | 1.85   |
| Traditionalist  | **Trad 0.16**  | Prog 2.76      | 2.60   |
| Populist        | **Pop 0.00**   | Accel 0.625    | 0.625  |
| Accelerationist | **Accel 0.09** | Pop 1.02       | 0.93   |

All five place correctly.

**The smallest margin is Populist 0.625 — and it is the GEOMETRIC MAXIMUM, not a
tuning shortfall.** The Populist and Accelerationist normalized _corners_ —
`(0.0, +0.5, −1.0)` and `(−0.5, +1.0, −0.5)` — are themselves exactly
`0.5·(0.5)² + (0.5)² + (0.5)² = 0.625` apart in the weighted metric. A perfectly
canonical Populist lands _on_ the Populist corner, so the nearest rival is 0.625
away by construction. **No number of questions can beat this ceiling** for an
on-corner answerer; it is a property of where the two tribes sit, not of coverage.

**Why v1's 0.55 rose only to 0.625, and why more State coverage was the wrong
lever.** Pop and Accel differ on S by only 0.5, and S is half-weighted — so State
is the single _weakest_ separator in the metric (max contribution
`0.5·0.5² = 0.125`). v1's lone State question left the canonical vector slightly
_off_ its corner (0.55). Adding State questions bought the last fraction of
"reach your own corner" (→ 0.625) and then hit the geometric wall. The real
separators are **Change intensity** (Pop `+0.5` vs Accel `+1.0`) and **Trust
depth** (Pop `−1.0` vs Accel `−0.5`), both full-weight — carried by Q6/Q12 and
Q4/Q8/Q11/Q13.

**What Q13 buys (real users, not the ceiling).** Because Accelerationist reveres
the builder (Q13-B, `T+1`) while Populist condemns him (Q13-A, `T−2`), the
canonical Accelerationist vector is pulled _off_ the boundary to `nT −0.2`,
resolving with a healthy **0.93** margin instead of sitting on the 0.625 knife
edge. For a noisy real user near the Pop/Accel line, Q13 is the highest-
information single question separating the pair — it reduces mis-placement even
though it cannot (and is not meant to) raise the canonical Populist ceiling.

See the header note for the standing **model-level open question**: the 0.625
corner distance may mean the 3-axis model is compressing grievance/restoration vs
techno-futurism. That is a coordinates/manifesto revisit for after real usage —
not a pre-launch score tweak.

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
  resolver is unit-tested against the §5 canonical-answers table (all 13 answer
  keys → self-placement, plus the low-confidence override trigger).
- The page is a `useState` step machine (mirrors `login/page.tsx`); question
  transitions use the `m.*` / `useReducedMotion` motion pipeline; options render
  with `@diktat/ui`'s `ChoiceButton`. 13 questions is within the flow budget; the
  progress indicator counts to 13.
- Copy passes the copy-linter / addiction-auditor gates; the quiz stays optional
  (skip preserved) per ADDICTION_ARCHITECTURE §11.
