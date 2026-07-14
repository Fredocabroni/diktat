# Diktat — Product Vision

> Status: living document. Captures the agreed product and decentralization
> vision. Sections marked **[NOW]** are safe to build in the current
> (centralized) app. Sections marked **[LATER]** are the post-launch
> decentralization/crypto track — mapped here as the destination, **not** a
> mandate to build before the app ships.

---

## 1. What Diktat Is

Diktat turns political discourse into a competitive sport. Users debate each
other in structured battles; an AI judge scores argument quality against a
fixed, viewpoint-neutral rubric; winning is about **arguing well** — evidence,
logic, structure, responsiveness — not being loud, popular, or on the "right"
side.

The bet: online political discourse is broken because it rewards outrage,
tribalism, and volume over reasoning. Diktat rewards *rigor* and confers
*status* for it — channeling political energy into something that rewards being
good at making a case.

One line: **the combat sport where you win by arguing well, own your identity
and economy, and can't be censored for your politics.**

---

## 2. The Core Loop

- **The Drop** — a daily, synchronized news moment (Wordle-style; everyone gets
  it at the same time). The ritual anchor that drives daily return. Curated, not
  an infinite doomscroll.
- **The Feed** — swipe through news cards, take stances (agree / disagree /
  next). Every card carries a **"⚔️ Battle This"** fork.
- **Tribes** — political factions (Libertarians, Populists, Progressives,
  Traditionalists, Accelerationists). Identity / belonging layer.
- **Battles** — the signature action. Structured debate rounds between two users,
  scored by an **AI judge on a fixed objective rubric** → skill-based win/loss.
- **AP (trophies)** — earned by winning battles. Drives tier progression.
- **Tiers** — a 12-rung status ladder (Citizen → Voter → … → the high tiers).
  The visible "earned status" that makes the climb meaningful.

Meta-goal: a user leaves each session feeling **sharper and more engaged**, not
"I just wasted an hour."

---

## 3. Onboarding — Tribe Quiz **[NOW]**

Replace the pick-from-a-list tribe selection with a short **placement quiz**:
answers place the user into the tribe they lean toward, with a clear **override**
if they disagree. Lower friction, more engaging, teaches the tribes by example,
and fits the combat-sport feel (you get *scouted* into a starting faction).
Override is mandatory so it never feels like it boxes anyone in.

*This is a pre-ship product improvement — no crypto, builds in the current app.*

---

## 4. AP = Trophies (not money) **[NOW]**

AP is **in-game progression only**, like Clash Royale trophies:

- Earned by winning AI-judged battles.
- Drives tier climb and status.
- **Never money. Never bought. Never cashed out.** Pure scoreboard.

This is the model the current app already implements (as of the tier-persistence
fix that made tiers actually advance with AP). No legal weight — it's points.

### The tier-3 gate — corrected meaning

The `tiers.payout_eligible` column (false for tiers 0–2, true for 3–11) was
originally stubbed as if **AP itself becomes cashable at tier 3**. That model is
**rejected** — AP never cashes out.

Its **correct** meaning under this vision: **tip-eligibility.** A user becomes
able to *receive crypto tips* at tier 3 (see §5). Same gate, corrected
semantics — nothing to remove, just reinterpret. No code change required now;
this note prevents anyone rebuilding the abandoned "AP = cashable" model.

---

## 5. The Crypto Layer — Peer Tipping for Good Arguments **[LATER]**

Separate from AP. This is the money layer, and it is **tipping, not gambling.**

- Users **tip each other crypto** when someone makes a genuinely good argument.
- The **AI quality score + user appreciation** *surface* what's tip-worthy —
  they help users find good arguments. **A human always chooses to send the
  tip.** The AI score does **not** auto-convert into an automatic payout.
  (Keeping the human in the loop is what keeps this clean "tipping," not a
  platform-operated reward/quality-payout system.)

### Tier gating on tips

- **Tipping unlocks at tier 3.** Below tier 3 you cannot receive tips — you're
  still proving yourself. This doubles as an anti-abuse ramp (no throwaway
  account earns immediately) and a natural KYC checkpoint.
- **Higher tier = higher tip ceiling.** Tier caps the size of tip a user can
  receive; climbing unlocks earning capacity. Ties earning to demonstrated
  skill.

### Design tension to build against (noted, not solved)

Tying earning capacity to tier (which comes from winning) incentivizes
*tier-grinding* over *argument quality*. Partial self-correction: tips are a
human choice, so a high-tier user with weak arguments has a high ceiling they
won't fill. Worth considering making the tip ceiling depend on *recent* argument
quality, not just raw tier, so users must keep making good points.

### Why tipping (the light legal path)

Tipping sidesteps the gambling/skill-gaming mountain that *staked* battles
(pay-to-enter, winner-takes-pot) would trigger. Nobody wagers or loses a stake on
a contested outcome. Still not zero-compliance: money-transmission / payments
care, **KYC at the tier-3 / money-out boundary**, tax reporting on earnings, and
**actual legal counsel before any real-money launch.** But this is a survivable,
launchable shape — a tipping platform with an off-ramp, not a licensed gambling
operator.

---

## 6. Decentralization — The Mission Layer **[LATER]**

Why it's core, not cosmetic: a platform whose whole purpose is *fair,
unmanipulable political combat* undermines itself if it can secretly tune the
economy, seize balances, or ban a viewpoint. Decentralization is a **credibility
requirement** for the mission.

Chosen axes:

- **Identity — decentralized.** Wallet-based, self-custodial, user-owned.
  Embedded/smart-wallet UX (email-smooth signup, wallet underneath) to keep it
  Gen-Z-friendly. Pseudonymous day-to-day; verified (KYC) only at the money-out
  boundary — this reconciles "own your identity" with "we can lawfully pay you."
- **Economy — on-chain.** AP as an on-chain token, **earned-only, never sold by
  the platform, no promise of appreciation** → far safer securities posture
  (avoids the "investment contract" shape). Trustless: balances live in
  contracts, not an editable database column.
- **Content — censorship-resistant + user-controlled moderation.** The principle
  is **"speech, not reach":** no central authority (including us) can *erase* a
  user's identity or content for their politics; but clients/users choose what to
  *display and amplify*, and unlawful content can be refused amplification /
  removed where legally required. This delivers "no political deplatforming, you
  own your voice and your feed" **while staying lawful** — the constraint being
  *no laws can be broken.* This is deliberately **not** "zero removal of anything
  ever," which would be both illegal (hosting illegal content) and fatal
  (app-store delisting, payment-rail loss).

### Staying centralized (for now)

- **Infrastructure / hosting** (Vercel, Railway, Supabase, Upstash) — pragmatic,
  revisit later.
- **Code / governance** — single repo, single owner, revisit later.

### Crypto is not a regulatory bypass

Explicit reminder: using crypto rails does **not** reduce legal obligations.
Regulators treat a regulated activity the same whether it settles in dollars or
tokens — and crypto adds token-as-security and AML scrutiny on top. Crypto is the
right *substrate* for ownership/identity/rails; it is orthogonal to the legal
work, which remains fully intact.

---

## 7. The AI Judge — Load-Bearing for Both Product and Law **[NOW to validate]**

Battles are decided by an **AI judge scoring argument quality against a fixed
objective rubric.** This mechanism is central twice over:

- **Product:** it's the thing that makes "win by arguing well" real instead of a
  popularity vote.
- **Law (later):** it's the skill-determination foundation that would make any
  future real-money layer defensible as skill, not chance.

Requirements for it to hold up:

- **Viewpoint-neutral by construction.** Score evidence, logical validity,
  responsiveness, structure, factual accuracy — dimensions a rigorous argument
  for *either* side can max out equally. If one political side systematically
  scores higher, the rubric is broken (and discoverable).
- **Consistent.** Same debate → same result (determinism; temperature 0; possibly
  multi-model consensus). A staked or reputational outcome that changes on re-run
  is indefensible.
- **Transparent.** The loser sees *why* they lost, per rubric dimension. No black
  box.
- **Ungameable.** Adversarially tested so users can't win by response length,
  keywords, or style tricks unrelated to merit.

Because this mechanism is load-bearing, it must be **proven as a feature in the
centralized app, with no money on the line, before it ever underpins earnings.**

---

## 8. Sequencing — Now vs. Later

Agreed order (decentralization/crypto is deferred until the app ships and the
core loop — especially the AI judge — is validated with real users):

**[NOW] — pre-ship, in the current centralized app**

1. Finish the tier-up celebration (in progress).
2. Tribe quiz onboarding (§3).
3. Document the corrected tier-3 gate meaning (§4) — done here.
4. Ship the app; validate: do people battle? Is the AI judge fun, fair,
   ungameable? (Validates the product *and* the future legal foundation for free.)

**[LATER] — post-launch decentralization track (mapped, not started)**

5. Harden the AI judge into a bulletproof, transparent, viewpoint-neutral system.
6. Wallet-based decentralized identity.
7. On-chain earned-only AP.
8. Crypto tipping layer (tier-3 gated, tier-scaled caps) + KYC-at-cashout.
9. Censorship-resistant + user-moderated content.
10. Legal counsel before any real-money (tipping off-ramp) launch.

Principle: **decentralize and monetize what works.** Don't build immutable
economic infrastructure around an unvalidated hypothesis.

---

## 9. Open Questions

- Tip ceiling: raw tier vs. recent-quality-weighted (§5 tension).
- Exact chain / L2 and token standard for AP + tips.
- Content protocol choice for censorship-resistance (evaluate Farcaster, Bluesky
  AT Protocol, etc.).
- KYC provider / flow that preserves day-to-day pseudonymity.
- Jurisdiction strategy (where to launch first; geofencing for the money layer).
