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

| Tribe (working slug)          | One-line definition                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Progressive** (`progressives`)   | Pro-change, pro-redistribution, secular; reform through institutions.                            |
| **Socialist** (`socialists`)       | Worker power, anti-capitalist economics, egalitarian — left of the left.                         |
| **Liberal** (`liberals`)           | Individual rights, market **plus** safety net, incremental, institutionalist.                    |
| **Conservative** (`conservatives`) | Tradition, markets, faith-friendly, incremental change.                                          |
| **Libertarian** (`libertarians`)   | Maximum individual freedom — economic **and** social — minimal state.                            |
| **Populist** (`populists`)         | Anti-establishment, people-vs-elites, economically heterodox.                                    |
| **Nationalist** (`nationalists`)   | Nation-first, sovereignty, cultural cohesion.                                                     |

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

| Axis                     | − pole                          | + pole                                  | Chief discriminator for              |
| ------------------------ | ------------------------------- | --------------------------------------- | ------------------------------------ |
| **ECON — economics**     | market / private provision      | collective / redistribution             | Socialist ↔ Libertarian/Conservative |
| **SOCIAL — values**      | tradition                       | progress                                | Conservative/Nationalist ↔ Progressive/Socialist |
| **STATE — authority**    | minimal state / individual liberty | strong state over the person         | Libertarian ↔ Nationalist/Socialist  |
| **ESTAB — establishment**| anti-establishment / populist   | institutionalist / defers to institutions | Populist ↔ Liberal/Progressive     |
| **NATION — scope**       | cosmopolitan / globalist        | nation-first / sovereigntist            | Nationalist ↔ Progressive            |

That is **five candidate axes** (up from three). The open scoping question is
whether all five are load-bearing or whether two correlate tightly enough in
practice to collapse to four (prime suspects: ESTAB and NATION may co-move for
several tribes). **Decide empirically during build**, not here.

**Illustrative belief-space sketch** (qualitative `−−/−/0/+/++`, **NOT** final
coordinates — coordinates and weights are calibrated in build so each tribe's
canonical answers self-place, exactly as TRIBE_QUIZ_PLAN §5 verified the old
five):

| Tribe          | ECON | SOCIAL | STATE | ESTAB | NATION |
| -------------- | :--: | :----: | :---: | :---: | :----: |
| Progressive    |  +   |   ++   |   +   |   +   |   −    |
| Socialist      |  ++  |   +    |   +   |   −   |   −    |
| Liberal        |  +   |   +    |   0   |  ++   |   −    |
| Conservative   |  −   |   −−   |   0   |   +   |   +    |
| Libertarian    |  −−  |   +    |  −−   |   −   |   −    |
| Populist       |  0   |   −    |   0   |  −−   |   +    |
| Nationalist    |  −   |   −    |   +   |   −   |   ++   |

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

_Build happens in a fresh session against this doc. Nothing above is implemented._
