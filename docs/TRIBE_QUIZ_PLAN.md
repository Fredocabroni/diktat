# Diktat — Tribe Quiz Onboarding: Content & Scoring Plan

> Status: shipped design (per docs/VISION.md §3). Pure frontend — reuses the
> existing `tribes.list` + `tribes.join` APIs; no backend/migration changes. The
> quiz replaces the _content_ of `/onboard/tribe`; the flow position (welcome →
> tribe → preview) is unchanged, and the "skip" / optional-ness is preserved.
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

Tribe names are never shown during the quiz. Axis scores (right column) are
hidden from the user.

### Q1 — Change

**"For as long as anyone remembers, your town's fire company has run on volunteers and handshakes — no certifications, no county oversight, neighbors saving neighbors. After one bad night, the state says professionalize: certified crews and real rules, or get shut down."**

| Option                                                                                                                                                      | Score |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "Modernize it. 'We've always done it this way' is not a fire plan — bring in the standards, even if the old guard walks."                                | C +2  |
| B. "Add the standards that save lives, keep the company that's always shown up. Reform it, don't replace it."                                               | C 0   |
| C. "Keep it in the town's hands. Strip out what made it work — the trust, the belonging — and you'll have a compliant service nobody answers the call for." | C −2  |

### Q2 — Trust

**"For a decade the official guidance said one thing, and millions built their lives around it. This week the same agencies reversed it — the old advice was shaky — and they're backing the new rule with the exact certainty they had for the old one."**

| Option                                                                                                                                                         | Score |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "That's the tell. When the same credentialed voices are this certain both times, you're watching a guild defend its authority, not follow the evidence."    | T −2  |
| B. "That's the process working — they moved when the data moved. Punish them for correcting course and you teach institutions to never admit they were wrong." | T +2  |
| C. "Take the finding, skip the sermon. Trust what they measured; don't let them dictate what you do about it."                                                 | T −1  |

_(C is a committed position, not a dodge: it accepts expert facts but rejects
technocratic authority over values — which risks undervaluing expert policy
judgment.)_

### Q3 — Change

**"The public high school that's anchored your town for a hundred years now graduates a third of its seniors reading at a sixth-grade level. Same building, same district, worse every year. What does it need:"**

| Option                                                                                                                                             | Score |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "Replace it. Open the doors to new schools, new operators, new models — a century of tradition doesn't earn it one more failing class."         | C +2  |
| B. "Overhaul it — new leadership, new curriculum, hard accountability — but keep the school the town built."                                       | C +1  |
| C. "The school isn't the disease. Rebuild what collapsed around it — gut the institution and you tear out the neighborhood's last anchor with it." | C −2  |

### Q4 — Trust

**"A family in your county is suing the hospital that three towns depend on — they say it botched a surgery and closed ranks. The hospital says the records show every protocol followed. The town is the jury pool, and honestly nobody knows."**

| Option                                                                                                                                                                       | Score |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "The family. The hospital has the lawyers, the records, and the reputation — the deck is stacked before anyone sits down. Institutions bury their mistakes for a living." | T −2  |
| B. "The hospital. It carries the protocols and the expertise that keep the rest of us alive — one grieving family's certainty isn't evidence."                               | T +2  |
| C. "The hospital — but open every record and let it be checked in daylight. Its word is worth exactly what it will let you verify."                                          | T +1  |

### Q5 — State

**"The town's biggest employer shuts down overnight — hundreds lose their paycheck at once. The response you'd get behind:"**

| Option                                                                                                        | Score |
| ------------------------------------------------------------------------------------------------------------- | ----- |
| A. "Clear the runway for what's next — cut the taxes and red tape so new employers move in and hire."         | S −2  |
| B. "Put a real floor under them — retraining, benefits, direct support — so no family free-falls in the gap." | S +2  |
| C. "Rally the town itself — local business, churches, neighbors — before any distant agency shows up."        | S 0   |

### Q6 — Change

**"A new technology could save a lot of lives — and carries risks nobody can fully map yet. The right pace:"**

| Option                                                                                              | Score |
| --------------------------------------------------------------------------------------------------- | ----- |
| A. "Ship it. People are dying on the waitlist while we hold hearings — delay has a body count too." | C +2  |
| B. "Move, but with guardrails — limits and oversight locked in before it scales."                   | C 0   |
| C. "Pump the brakes. Some doors don't close once they're open."                                     | C −2  |

### Q7 — State

**"A working family two towns over can't cover a hospital bill that would wipe out a year's savings. The fix that sits right with you:"**

| Option                                                                                                                      | Score |
| --------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "Guarantee it collectively — some needs are too basic to leave to whether you can pay."                                  | S +2  |
| B. "Open the market — real prices, real competition — so care costs what it should instead of whatever the cartel charges." | S −2  |
| C. "Neither bureaucracy nor billing department — mutual aid, community funds, people covering their own."                   | S 0   |

### Q8 — Trust

**"A man everyone knows is guilty walks free — police skipped a warrant, the evidence is thrown out. The system worked exactly as written."**

| Option                                                                                                                                                                                                           | Score |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "The rules held, and that's the point — you trust the _process_ precisely because you can't trust the _people_ running it. Better a guilty man free than officials who decide the rules don't apply to them." | T −1  |
| B. "A guilty man walks and the victim gets nothing. The rules aren't sacred — they're the fine print insiders hide behind while ordinary people eat the loss."                                                   | T −2  |
| C. "The law has to hold even when it stings. An institution that bends its own rules for the mob's outrage is worth less than one that frees a guilty man on principle."                                         | T +2  |

_(Rev 4 rescore: A previously smuggled an anti-state-power sentiment into a
T-distrust score. It now earns `T−1` honestly — distrust of the officials, trust
in the framework — with no S-axis leak. A vs B remains the Libertarian↔Populist
splitter.)_

### Q9 — State

**"A rural stretch of your region has no fast internet — too unprofitable to wire. Kids do homework in parking lots. The move:"**

| Option                                                                                                                   | Score |
| ------------------------------------------------------------------------------------------------------------------------ | ----- |
| A. "Public build — some infrastructure only exists because we decide together to lay it; the market already said no."    | S +2  |
| B. "Change the math for builders — clear the permits, hand over the spectrum, let a company find the profit and run it." | S −2  |
| C. "Let the towns wire themselves — local co-ops, neighbors pooling to string their own line."                           | S 0   |

### Q10 — State

**"A neighbor's been on public support three years. Half the town calls it a lifeline; half calls it a trap that pays people to stay stuck. Your read on the program:"**

| Option                                                                                                  | Score |
| ------------------------------------------------------------------------------------------------------- | ----- |
| A. "Fund it without flinching — letting people drown to 'motivate' them is cruelty with a spreadsheet." | S +2  |
| B. "Shrink it to a floor — help that's easy to lean on forever stops being help and becomes a cage."    | S −2  |
| C. "Tie it to the community — work he can do, people who know his name — not a check and not a cutoff." | S 0   |

### Q11 — Trust

**"The one institution you've always defended — your proof the system can work — quietly did something indefensible and buried it. It comes out. Where do you land:"**

| Option                                                                                                                                      | Score |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "It's done. If even that one covered its own rot, the whole class of them runs on nerve and PR, not trust."                              | T −2  |
| B. "One betrayal doesn't erase what it earned. Hold this to account, but don't torch an institution that's been right far more than wrong." | T +2  |
| C. "Exactly why nothing gets a permanent pass — trust it only as far as it's audited, and audit it harder now."                             | T −1  |

### Q12 — Change

**"Your city can bet its budget on one big swing — level the aging downtown and rebuild it from scratch as something new — or keep patching what's there, block by block, year by year. The council asks where you land:"**

| Option                                                                                                                          | Score |
| ------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "Swing big. A city that only ever patches just decays in slow motion — bet the budget and build something worth inheriting." | C +2  |
| B. "One bold project the city can afford to lose, the rest kept in repair. Gamble a corner, not the whole treasury."            | C 0   |
| C. "Patch and maintain. You don't stake a city's one budget on a blueprint nobody's ever built."                                | C −2  |

_(Rev 4 replacement: the cut Q12 measured personal risk tolerance and mis-scored
it on the Change axis. This is a **public** decision with **public** stakes —
same swing-vs-caution energy, correct construct.)_

### Q13 — Trust _(Populist ↔ Accelerationist fault line)_

**"A founder almost nobody voted for now controls the tools half the country runs on — how they talk, pay, and get their news. He says he's dragging the future forward faster than any government ever could. He's not wrong that it works."**

| Option                                                                                                                                                                 | Score |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A. "That's the oldest story there is, in a hoodie. Unelected power over millions is unelected power — a king is a king whether the crown is a server farm."            | T −2  |
| B. "Good. Someone finally building instead of holding hearings — I'll take the person shipping the future over the committee that would still be studying it in 2040." | T +1  |
| C. "Power's fine as long as you can walk away. The moment you can't switch off his tools without switching off your life, it's not a product — it's a sovereign."      | T −1  |

_(Added in rev 4. Populist reads the builder as another insider (A, `T−2`);
Accelerationist reveres the builder (B, `T+1`); the middle is a
contestability/exit stance (C, `T−1`). This is the one question that pulls the
tightest pair apart on the T axis — see §5. It does not raise the geometric
ceiling; it reduces mis-placement of noisy real users on that boundary.)_

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
