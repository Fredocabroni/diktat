# Diktat — Tribe Overhaul: 7 Recognizable Identities

> Status: **decision doc, not built.** Captures an agreed product decision and
> scopes the work; the build happens in a fresh session against this doc.
>
> **Supersedes the tribe direction in `docs/TRIBE_QUIZ_PLAN.md`.** That doc (the
> 5-invented-tribe, 3-axis, 13-question quiz) is now historical. Its _mechanics_
> (hidden axis scores, viewpoint-neutral scenes, normalize-then-nearest-target
> resolver, mandatory override) are reused; its _tribes, axes, coordinates, and
> question set_ are replaced by this plan. Do not build against TRIBE_QUIZ_PLAN
> §2–5 anymore.
>
> Anchors: VISION §3 (tribes as an onboarding step), VISION §7 (the quiz is the
> first thing a user touches and must stay viewpoint-neutral — no house lean),
> ADDICTION_ARCHITECTURE §10 (autonomy — no coercive placement) and §11 (flow /
> optional-ness preserved).

---

## 1. The decision

Replace the five **invented** tribes (Libertarian, Populist, Progressive,
Traditionalist, Accelerationist) with **seven recognizable real-world
identities**.

**Why.** The invented names didn't land — "what's an Accelerationist?" is a
bounce, not an identity. Users adopt a tribe faster when the label is one they
_already claim_. Recognizability is the product goal.

**Why still archetypes, not single-axis labels.** Real people are a _mix_ of
axes; a label like "pro-market" or "socially liberal" is one axis, not a person.
So each of the seven remains an **archetype — a specific combination across
several axes — that happens to carry a recognizable name.** This is the Pew
Research Political Typology approach: named clusters ("Faith and Flag
Conservatives," "Progressive Left") defined by a _pattern_ of positions, not a
single slider. We keep the "distinct region of belief-space" model from the old
plan; we only change the number of regions, their names, and the axes that
define them.

---

## 2. The seven tribes

Each is a distinct region of belief-space with a recognizable name. One-line
definition each (full manifestos are build work — see §6):

| Tribe (working slug)               | One-line definition                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| **Progressive** (`progressives`)   | Pro-change, pro-redistribution, secular; reform through institutions.         |
| **Socialist** (`socialists`)       | Worker power, anti-capitalist economics, egalitarian — left of the left.      |
| **Liberal** (`liberals`)           | Individual rights, market **plus** safety net, incremental, institutionalist. |
| **Conservative** (`conservatives`) | Tradition, markets, faith-friendly, incremental change.                       |
| **Libertarian** (`libertarians`)   | Maximum individual freedom — economic **and** social — minimal state.         |
| **Populist** (`populists`)         | Anti-establishment, people-vs-elites, economically heterodox.                 |
| **Nationalist** (`nationalists`)   | Nation-first, sovereignty, cultural cohesion.                                 |

**Nationalist — editorial guardrail (non-negotiable).** This tribe replaces the
"fascist" idea from brainstorming. It is included _because_ it is a real,
mainstream identity, and it is written **only** in its strongest **legitimate**
form: sovereignty, border control, national cohesion, skepticism of
supranational bodies — the version a thoughtful nationalist would proudly claim.
**No dog whistles, no ethnic or racial framing, no coded language.** The
manifesto and every Nationalist quiz option must clear `copy-linter` **and** a
manual neutrality review (mirror the fact-check neutrality contract, VISION §7).
If a legitimate form can't be written cleanly, the tribe does not ship — but the
bar is "strongest legitimate," not "excluded."

---

## 3. The axis model to build (scope, not final)

The old 3-axis model (**C** change · **T** trust · **S** state) is **structurally
insufficient** for these seven, for a specific reason: it _conflated_ distinct
dimensions.

- Old **S (state power)** bundled **economics** (market vs redistribution) with
  **authority** (personal liberty vs state coercion). Libertarian and Socialist
  can both distrust the establishment yet sit at opposite economic poles;
  Nationalist wants a _strong state_ but not _redistribution_. One axis can't
  hold that.
- Old **C (change)** bundled **social values** (tradition vs progress) with
  **institutional reform pace**. Conservative and Nationalist share social
  tradition but diverge elsewhere; Progressive and Socialist share social
  progress but diverge on economics.
- Old **T (trust)** is really an **establishment / anti-establishment** axis, and
  it's the cleanest survivor.

**Proposed axes for the new model (to be finalized in build, not here):**

| Axis                      | − pole                             | + pole                                    | Chief discriminator for                          |
| ------------------------- | ---------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| **ECON — economics**      | market / private provision         | collective / redistribution               | Socialist ↔ Libertarian/Conservative             |
| **SOCIAL — values**       | tradition                          | progress                                  | Conservative/Nationalist ↔ Progressive/Socialist |
| **STATE — authority**     | minimal state / individual liberty | strong state over the person              | Libertarian ↔ Nationalist/Socialist              |
| **ESTAB — establishment** | anti-establishment / populist      | institutionalist / defers to institutions | Populist ↔ Liberal/Progressive                   |
| **NATION — scope**        | cosmopolitan / globalist           | nation-first / sovereigntist              | Nationalist ↔ Progressive                        |

That is **five candidate axes** (up from three). The open scoping question is
whether all five are load-bearing or whether two correlate tightly enough in
practice to collapse to four (prime suspects: ESTAB and NATION may co-move for
several tribes). **Decide empirically during build**, not here.

**Illustrative belief-space sketch** (qualitative `−−/−/0/+/++`, **NOT** final
coordinates — coordinates and weights are calibrated in build so each tribe's
canonical answers self-place, exactly as TRIBE_QUIZ_PLAN §5 verified the old
five):

| Tribe        | ECON | SOCIAL | STATE | ESTAB | NATION |
| ------------ | :--: | :----: | :---: | :---: | :----: |
| Progressive  |  +   |   ++   |   +   |   +   |   −    |
| Socialist    |  ++  |   +    |   +   |   −   |   −    |
| Liberal      |  +   |   +    |   0   |  ++   |   −    |
| Conservative |  −   |   −−   |   0   |   +   |   +    |
| Libertarian  |  −−  |   +    |  −−   |   −   |   −    |
| Populist     |  0   |   −    |   0   |  −−   |   +    |
| Nationalist  |  −   |   −    |   +   |   −   |   ++   |

This sketch is only to show the seven **are** separable given the richer axis set
— it is the argument for five axes, not a spec. Whether the model needs all five,
how they're weighted, and the exact per-tribe coordinates are the first build
task.

---

## 4. Adaptive branching (the mechanic for close pairs)

**The problem this solves.** With seven tribes packed into belief-space, some
pairs sit close and _will_ bleed together — most sharply **Liberal ↔
Progressive** (both center-left, both institutionalist; they differ mainly in
the _intensity_ of social progressivism and redistribution and in reform pace).
Secondary risk pairs: **Socialist ↔ Progressive**, **Conservative ↔
Nationalist**, **Populist ↔ Nationalist**. A fixed-length quiz forces a coarse
guess exactly where the guess is least reliable.

**The chosen mechanic: adaptive branching (Pew-style follow-ups).**

1. **Core pass** — a fixed set of questions, roughly balanced across the final
   axes, places the user in belief-space. Compute nearest tribe and the margin to
   the runner-up (reuse the old resolver's confidence idea: `d²` gap +
   vector-magnitude gate).
2. **Border detection** — if the top two (or top-N) tribes fall inside a
   fuzzy-border threshold, the placement is _not_ finalized. Instead of guessing,
   the quiz serves **targeted tie-breaker questions chosen for that specific
   contested pair** — questions engineered to maximally separate, e.g., Liberal
   from Progressive on their distinguishing axes (redistribution intensity, pace
   of change, social-identity questions), not generic ones.
3. **Resolve or cap** — re-score with the tie-breakers folded in. Cap the extra
   rounds (proposal: **≤ 2 extra mini-rounds**, a couple of questions each) so the
   flow budget and fatigue stay bounded (ADDICTION §11).
4. **Fallback** — if still ambiguous after the cap, open on the **mandatory
   override** (the "Not you? Pick another" all-tribes card list from the old §6),
   now listing seven. A low-confidence result is never a dead end.

**Design shape.** Precompute, for each adjacent tribe _pair_, a small bank of
discriminator questions. Border detection selects the bank for the contested
pair. This keeps the branching a **static, testable decision structure** rather
than open-ended generation — important, because it means the resolver stays
unit-testable (see the §6 test note and the §7 open question about the resolver
losing its pure-function shape).

---

## 5. This is a full redo — scope of change

Not a quiz edit. Everything the old five tribes touch:

**Data / migrations**

- **New seed migration** replacing `20260420090008` (the current 5-tribe seed).
  Goes through the **gated `deploy-migrations` pipeline** (not applied ad hoc).
  Use a full 14-char timestamp name (`YYYYMMDDHHMMSS_seed_seven_tribes.sql`) per
  the migration-naming rule in CLAUDE.md.
- **Slug plan.** Reuse `progressives` / `libertarians` / `populists` (names
  survive); add `socialists` / `liberals` / `conservatives` / `nationalists`;
  retire `traditionalists` / `accelerationists`. Note the _meaning_ of the
  surviving slugs shifts (new coordinates), so canonical answers change even where
  the slug is stable.
- **Existing-user tribe migration.** Users are already joined to the old five
  slugs (`tribes.join`). Need a mapping + policy: which old tribe maps to which
  new one, where a clean map doesn't exist (Traditionalist splits toward
  Conservative/Nationalist; Accelerationist has no direct heir), and whether to
  silently remap, prompt a re-quiz, or offer an opt-in re-take. **Consent/UX and
  ADDICTION §10 autonomy both bear on this — see open questions.**

**Content**

- **7 new manifestos** (drive the result screen and `tribes.list`). Nationalist
  per the §2 guardrail. All seven through `copy-linter` + neutrality review.

**Quiz module (`apps/web/app/onboard/tribe/quiz.ts` — full rebuild)**

- New `Axis` type (4–5 axes), new `TRIBE_TARGETS` (7 tribes × final axes), new
  question set (balanced across the new axes), new normalization/weights, new
  resolver **with the adaptive-branching flow** (no longer a single pure pass over
  a flat answer array).
- **Resolver tests** — new canonical-answer keys per tribe (self-placement, as in
  TRIBE_QUIZ_PLAN §5), **plus** border-zone triggering, tie-breaker resolution,
  the round cap, and the low-confidence override trigger.

**UI**

- Onboarding step machine: progress indicator can no longer count to a fixed 13 —
  it must handle a variable length (core pass + optional branch rounds).
- Result screen + override card list now render **seven** tribes.
- Any consumer of `tribes.list` / hardcoded old slugs across `web`, `bots`,
  analytics/events, seed fixtures, and docs.

**Docs**

- This doc supersedes the tribe direction in `TRIBE_QUIZ_PLAN.md` (add a
  superseded banner there when the build starts). Log the overhaul in
  `docs/TYRION_BUILD_QUEUE.md`.

**Unchanged (reused, don't rebuild):** `tribes.list` / `tribes.join` API shape;
the welcome → tribe → preview flow position; skip/optional-ness; hidden axis
scores; viewpoint-neutral scene principle.

---

## 6. Open questions (decide in build)

1. **Axis count — 4 or 5?** Do ESTAB and NATION (or any pair) correlate tightly
   enough across the seven to collapse? Fewer axes = simpler quiz, less
   separation. Resolve with the coordinate sketch turned into real numbers.
2. **Coordinates & weights.** Per-tribe target vectors and per-axis weights that
   make every tribe's canonical answers self-place with a healthy margin — and
   what the tightest achievable pair margin is (the old model documented a 0.625
   geometric floor for Pop↔Accel; the new Liberal↔Progressive pair will have its
   own floor, which is the reason branching exists).
3. **User-migration policy.** Silent remap vs. forced re-quiz vs. opt-in re-take
   for existing members — especially the tribes with no clean heir
   (Accelerationist) or that split (Traditionalist). Balance data continuity
   against ADDICTION §10 autonomy (don't override a user's own prior choice
   without consent).
4. **Branching depth & fatigue budget.** Max extra rounds, questions per round,
   and total worst-case length before the override takes over.
5. **Resolver purity vs. statefulness.** Adaptive branching makes placement
   multi-step and stateful, breaking the old "pure function over a flat answer
   array" property that made it trivially unit-testable. Decide the shape — e.g.,
   a pure `next-question` reducer + a pure `resolve` step — that keeps it testable.
6. **Viewpoint-neutrality with claimed labels (VISION §7).** Names are now
   identities users claim, not invented words. Confirm labels stay **hidden during
   the quiz** and are revealed only at the result, so the first-touch surface still
   shows no house lean.
7. **Nationalist editorial process.** Who signs off on the "strongest legitimate
   form," and the standing review gate on that manifesto and its options.

---

## 7. Rev 2 — concrete-issue questions (the built model)

The abstract-axis questions (change-vs-continuity etc.) were replaced with **concrete
issue questions** — the real political battlefield asked directly (the Pew approach).
Abstract framing hoped positions would be _implied_; real placement needs the actual
issues people hold opinions about. The 5 axes and 7 tribe coordinates are unchanged;
only what the questions measure changed, then the deltas were recalibrated.

- **12 core issue questions**, single-axis each: ECON (taxes, healthcare, welfare),
  SOCIAL (abortion, LGBTQ, religion-in-public-life), STATE (guns, crime/policing),
  NATION (immigration, foreign policy/allies), ESTAB (trust-in-experts, elites-vs-people).
- **Forced-choice framing** (Pew): a standing intro line, "Pick the answer closest to
  your view, even if neither is exactly right." Some questions are binary forced-lean
  (where a middle is a dodge), some 3-option (where a tribe genuinely lives at the
  midpoint, e.g. ECON-0 = Liberal/Populist/Nationalist; STATE-0 = Liberal/Conservative/
  Populist). Guns and foreign policy carry **moderate** (±1) deltas so they tip only
  the Libertarian/nationalist extremes, not partisan gun-culture or anti-interventionism.
- **Balance bar (VISION §7):** every option is the strongest, most defensible form of
  that position. No strawman, no house lean.

### 7.1 Three tie-breaker banks (terminal, no cascade)

Concrete issues cleanly separate 4 tribes but collapse **three issue-twin pairs** —
tribes that answer loud issues nearly identically and differ only by intensity or
temperament. Each collapse gets a 2-question runoff that probes the _distinguishing
dimension_, not another loud issue:

- **Progressive ↔ Socialist** — reform vs. replace (work within capitalism/institutions
  vs. replace the system / organize outside it).
- **Populist ↔ Nationalist** — object of grievance (domestic insider elites vs. foreign
  forces / the nation).
- **Conservative ↔ Populist** — institutions: defend and repair vs. demolish.

**Mechanic:** core vector → nearest two tribes. If their `d²` gap is below the border
threshold, fire **only** the bank matching that unordered pair (`{prog,soc}`→PS,
`{pop,nat}`→PN, `{con,pop}`→CP); any other close pair, or a near-neutral vector, opens
the all-seven override. The bank is a **terminal pairwise runoff** — one bank, one
tally, assigned to one of those two tribes. The 7-way resolution never re-runs, so
there is no cascade (important because Populist appears in two banks — the trigger keys
off the actual nearest-two, never off "is Populist involved"). All 7 canonical
answer-sets self-place (4 directly, Prog via PS, Pop via PN).

### 7.2 DEFINITIONAL DECISION — do not "fix" this later

**Conservative = traditional + institutionalist. An issue-conservative who is
anti-establishment resolves to _Populist_, by design — not a bug.**

Institutional trust (ESTAB) is a **primary placement dimension**, not a secondary
flavor. On concrete issues, Conservative and right-Populist are nearly identical (both
market-ish, socially traditional, nation-first, tough-on-crime); the _only_ thing that
distinguishes them is trust in institutions. So ESTAB is deliberately weighted heavily
enough that two anti-establishment answers move an otherwise-conservative respondent
into Populist. That is the model correctly surfacing the real, defining split in
current politics (institutionalist conservative vs. anti-establishment populist-right),
the same way Pew's typology separates them.

Consequence, stated plainly so future-me doesn't "correct" it: a Conservative/Populist
tie-breaker **cannot** recover an anti-establishment issue-conservative to Conservative,
because their core vector isn't near Conservative at all — it sits in the Populist/
Nationalist cluster, and a runoff only chooses among the nearest two. This was
evaluated and **accepted**. Do not down-weight ESTAB or add machinery to "rescue"
issue-conservatives into Conservative; doing so would erase the institutionalist-vs-
anti-establishment distinction that is the whole point of separating those two tribes.
(The alternative — ESTAB as a secondary tiebreaker — was considered and rejected: see
the Option A decision.)

### 7.3 Rev 3 — graduated economics + re-derived coordinates

Real-usage bug: a mainstream Democrat (raise taxes on the wealthy, public healthcare,
fund the safety net) resolved to **Socialist**. Root cause — the ECON collective
options were phrased as full-socialist, so a redistributionist Democrat maxed the axis
to Socialist's exact coordinate (+1.0); and the corrupt-senator Q12 pulled "insiders"
(−2) from everyone, dragging institutionalist Democrats anti-establishment. Three fixes:

- **Graduated ECON (Fix A):** the three ECON questions now score the moderate-left
  option `+1` and the revolutionary-left option `+2`. Only worker-ownership /
  replace-capitalism language reaches +2; a reformist Democrat (public option, modest
  taxes) nets ~+0.33–0.67, landing Liberal/Progressive, not Socialist.
- **Q12 measures illegitimacy, not corruption (Fix B):** the options now distinguish
  "enforce the law and vote them out" (institutionalist) from "the system is rigged by
  design, no election changes it" (anti-establishment). A Democrat disgusted by one
  corrupt senator stays ESTAB-positive.
- **Reachability + re-derived coordinates (Fix C):** graduated deltas make the odd
  sums (e.g. +0.5) reachable, and every tribe's coordinate is now re-derived as its
  **honest issue-answer vector** — the principled definition for an issue quiz. Several
  moved from the old hand-set values (Progressive → ESTAB +1.0 / STATE −0.33 / NATION
  −1.0; Liberal → ECON +0.33, closing the coverage hole that made it unreachable).

**Fourth bank (PL, prog/lib).** Fixing the left made Liberal↔Progressive the closest
mainstream-left pair — the left's analog of Con/Pop — so it gets its own terminal
runoff (incremental-vs-structural change + work-within-vs-overhaul institutions). Four
banks now: PS `{prog,soc}`, PN `{pop,nat}`, CP `{con,pop}`, PL `{prog,lib}`. All four
pairs are distinct, so nearest-two → at most one bank; the mechanic stays terminal and
unambiguous (Prog is in PS+PL, Pop in PN+CP, disambiguated by the actual runner-up).

Regression-locked in the resolver test: mainstream Democrat → Liberal, mainstream
Republican → Conservative. §7.2 still holds (an anti-establishment issue-conservative
still resolves to Populist/Nationalist).

---

_Rev 3 (graduated economics, illegitimacy Q12, re-derived coordinates, four terminal
banks) is the shipped model. §3–4's abstract-axis framing is superseded by §7 for
content; §7's coordinates supersede the §1–2 sketch._
