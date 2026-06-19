## Security Review — PR: sessions_close_only_update (`20260618200000`)

### 1. Summary of Security-Relevant Changes

This PR closes M3, a previously open medium finding. The `sessions` table received a broad `GRANT UPDATE` in migration `20260617160000`, enabling any authenticated user to rewrite every column on their own open session rows. This PR applies a two-layer defence:

- **Layer 1 (GRANT):** Revokes the table-level UPDATE grant for `authenticated`; re-grants column-scoped UPDATE on `ended_at` only. The remaining six columns (`id`, `user_id`, `started_at`, `device_kind`, `app_version`, `created_at`) become structurally immutable to a client-initiated UPDATE before RLS runs.
- **Layer 2 (RLS WITH CHECK):** Replaces the loose `WITH CHECK (is_self(user_id))` with a four-condition check that pins the post-image to a valid close: caller owns the row, `ended_at IS NOT NULL`, `ended_at <= now() + 1 minute`, and `ended_at >= started_at - 1 minute`. The USING clause (`is_self(user_id) AND ended_at IS NULL`) is unchanged.

No application code (`apps/api/`, `apps/web/`, `apps/workers/`) is changed in this PR.

---

### 2. Findings

#### CRITICAL

None.

---

#### HIGH

None introduced by this PR. The pre-existing HIGH findings (H2 — cursor clamp, H3 — ghostEarnings aggregate push-down) remain open and are not touched here.

---

#### MEDIUM

**M-1 — No upper bound on open `sessions` rows per user (session flooding)**

- **Severity:** MEDIUM
- **Description:** The INSERT policy (`sessions_insert_self`) has no guard on how many concurrent open (`ended_at IS NULL`) sessions a single user may hold. An authenticated user can INSERT an unbounded number of open session rows. This table is provisioned-but-unused observability infrastructure today, but when it is wired to any product feature (analytics, session-length nudges, break recommendations, or presence signals), the lack of an upper bound creates a DoS surface against the table and any query that JOINs or scans by `user_id`. This PR does not touch INSERT.
- **Affected location:** `supabase/migrations/20260420090002_identity_and_economy.sql` — `sessions_insert_self` policy.
- **Recommended fix:** Add a `WITH CHECK` sub-select that counts open rows for the caller and rejects when `COUNT(*) >= N` (e.g. N=5). Alternatively, enforce a `UNIQUE (user_id) WHERE ended_at IS NULL` partial unique index if only one concurrent open session is ever legitimate. Follow-up item; not a blocker on this PR.

---

#### LOW

**L-1 — `ended_at >= started_at - interval '1 minute'` lower bound reads a client-supplied column**

- **Severity:** LOW
- **Description:** The WITH CHECK lower bound references the row's own `started_at`, which was supplied by the client at INSERT time and is validated only to within `[now()-1m, now()]` by `sessions_insert_self`. The column-level grant introduced by this PR correctly prevents a self-UPDATE from changing `started_at`. However, the combination allows a client to record a session with `ended_at < started_at` by up to 59 seconds (client clock ahead at INSERT, behind at UPDATE). Currently zero impact — no rewarded metric reads session duration — and the migration comment correctly identifies and accepts this. Recorded for awareness only.
- **Affected location:** `supabase/migrations/20260618200000_sessions_close_only_update.sql` line 134.
- **Recommended fix:** No action required while `sessions` is observability-only. If a future feature gates any reward or break recommendation on session duration, replace the client-trusted lower bound with `ended_at >= now() - interval '5 minutes'` (server-authoritative) and route closes through a `SECURITY DEFINER close_session()` RPC that stamps `ended_at = now()` server-side.

**L-2 — No CI migration apply gate (pre-existing; elevated by this PR's own tracking)**

- **Severity:** LOW (pre-existing)
- **Description:** `ci.yml` runs `pnpm turbo test` with mocked DB clients — no ephemeral Postgres job applies the full migration set from zero. A syntactically valid but semantically broken migration can pass CI and reach a production database. This PR correctly documents the gap as `[P0-before-prod]` and provides a manual interim via `dev-validate-trivia-migration-fresh-apply.mjs`.
- **Affected location:** `.github/workflows/ci.yml`.
- **Recommended fix:** Add a GHA job using `services: postgres:17` or `supabase start` that applies all migrations in order from a clean schema and exits non-zero on failure. Must land before any `diktat-prod` Supabase project is provisioned.

---

#### INFO

**I-1 — Rollback script restores the previously insecure WITH CHECK**

- **Severity:** INFO
- **Description:** The inline rollback (comment block lines 92–99) correctly reconstructs `WITH CHECK (public.is_self(user_id))` — the prior insecure form. This is expected for a rollback, but an on-call responder executing it verbatim under stress would re-open M3 without an obvious warning. A one-line note in the rollback block ("this reverts to the previously insecure policy; see M3 for context") would make intent explicit.
- **Affected location:** `supabase/migrations/20260618200000_sessions_close_only_update.sql` lines 92–99.

**I-2 — `service_role` retains full table UPDATE via the schema-wide grant in `20260427`**

- **Severity:** INFO (correct posture, no action required)
- **Description:** Column-level revokes on `authenticated` do not cascade to `service_role`. Workers, reapers, and any future `close_session()` RPC are unaffected. This posture is correct.

**I-3 — No DELETE policy or grant for `authenticated` on `sessions`**

- **Severity:** INFO (correct posture, observation only)
- **Description:** Authenticated users cannot delete their own session rows. Correct for an observability table — rows are immutable once closed. Worth making the absence of a DELETE policy explicit in a comment so the next auditor reads it as deliberate rather than an omission.

---

### 3. Checklist Results

| Check | Result |
|---|---|
| Service-role keys never in client bundles | PASS — unchanged; `SUPABASE_SERVICE_ROLE_KEY` confined to `apps/api/` and `apps/workers/` |
| JWT verification | PASS — unchanged; `verifyJwt` uses Supabase SDK; no bare `jwt.decode` present |
| RLS active on `sessions` | PASS — `ENABLE ROW LEVEL SECURITY` in `20260420090002`; this PR tightens, not loosens |
| Rate limits on public endpoints | PRE-EXISTING OPEN — no `@fastify/rate-limit`; tracked in CLAUDE.md; not introduced or worsened here |
| Input validation | PASS — no application code changed; the only writable column is `ended_at`, bounded by WITH CHECK in the DB layer |
| No string-concat SQL | PASS |
| New deps with critical CVEs | PASS — no dependency changes |

---

### 4. Overall Verdict

**APPROVE WITH NOTES**

The migration is mechanically correct and closes M3 with a well-reasoned two-layer defence. The GRANT layer is the primary security gate (column-scoped, evaluates before RLS); the WITH CHECK is correct defence-in-depth. L-1's `started_at` reference has zero current impact because no rewarded metric reads session duration and `started_at` is now structurally immutable to a self-UPDATE.

Two items to carry forward:

1. **CI migration apply gap (L-2, `[P0-before-prod]`)** — must land before any production Supabase project is provisioned.
2. **Session-flooding INSERT bound (M-1)** — should be addressed before `sessions` is read by any product feature.

