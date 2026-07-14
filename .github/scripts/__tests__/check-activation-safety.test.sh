#!/usr/bin/env bash
#
# Fixture-based test for .github/scripts/check-activation-safety.sh.
# Proves both directions of the gate:
#   - GREEN: flags unset → trivial green-pass.
#   - GREEN: flags armed AND the real deploy workflows pinned correctly
#            → green-pass.
#   - RED:   flag armed AND the workflow has any floating `uses:@vN`
#            tag → exit 1 with a classified ::error:: message.
#   - RED:   flag armed AND the workflow has any unpinned CLI install
#            (`@latest`, bare `npm i -g`, or `curl|sh`) → exit 1.
#
# Run:
#   bash .github/scripts/__tests__/check-activation-safety.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/check-activation-safety.sh"

# Fixtures live in a temp dir so the test never mutates the real deploy
# workflows. The script accepts RAILWAY_WORKFLOW_FILE / VERCEL_WORKFLOW_FILE
# env overrides specifically so this harness can swap in synthetic
# fixtures without touching the working tree.
FIX_DIR="$(mktemp -d)"
trap 'rm -rf "$FIX_DIR"' EXIT

pass_count=0
fail_count=0

# Run the script with given flag values + workflow-file overrides, then
# assert exit code matches expectation. For RED cases, also require the
# stderr to contain the expected ::error:: substring.
run_case() {
  local label="$1"
  local enable_railway="$2"
  local enable_vercel="$3"
  local railway_file="$4"
  local vercel_file="$5"
  local expected_exit="$6"
  local expected_stderr_substr="${7:-}" # optional

  # Migration flag/file are optional overrides (MIG_ENABLE / MIG_FILE). They
  # default OFF, so every existing case leaves the migration check skipped and
  # is unaffected; migration cases set them inline before calling run_case.
  local actual_exit actual_stderr
  actual_stderr=$(
    ENABLE_RAILWAY_DEPLOY="$enable_railway" \
    ENABLE_VERCEL_DEPLOY="$enable_vercel" \
    ENABLE_MIGRATION_DEPLOY="${MIG_ENABLE:-}" \
    RAILWAY_WORKFLOW_FILE="$railway_file" \
    VERCEL_WORKFLOW_FILE="$vercel_file" \
    MIGRATION_WORKFLOW_FILE="${MIG_FILE:-$vercel_file}" \
      bash "$SCRIPT" 2>&1 >/dev/null
  ) && actual_exit=0 || actual_exit=$?

  local ok=1
  if [ "$actual_exit" != "$expected_exit" ]; then
    ok=0
  fi
  if [ -n "$expected_stderr_substr" ] && ! printf '%s' "$actual_stderr" | grep -qF "$expected_stderr_substr"; then
    ok=0
  fi

  if [ "$ok" = 1 ]; then
    echo "  ✓ ${label}"
    pass_count=$((pass_count + 1))
  else
    echo "  ✗ ${label}"
    echo "      expected exit ${expected_exit}, got ${actual_exit}"
    if [ -n "$expected_stderr_substr" ]; then
      echo "      expected stderr substring: ${expected_stderr_substr}"
    fi
    echo "      actual stderr:"
    printf '%s\n' "$actual_stderr" | sed 's/^/        /'
    fail_count=$((fail_count + 1))
  fi
}

# Fixture builders. Each writes a minimal-but-realistic deploy workflow
# shape to FIX_DIR/<name>.yml and echoes the path.

write_railway_pinned() {
  local out="$FIX_DIR/railway-pinned.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: .nvmrc
      - name: Install Railway CLI
        run: npm i -g @railway/cli@5.20.0
YAML
  printf '%s' "$out"
}

write_vercel_pinned() {
  local out="$FIX_DIR/vercel-pinned.yml"
  cat > "$out" <<'YAML'
name: deploy-vercel
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
      - name: Install Vercel CLI
        run: npm i -g vercel@54.14.5
YAML
  printf '%s' "$out"
}

write_railway_floating_uses() {
  # Regress only the uses: ref to @v4 — every other line pinned. Detector
  # must surface this one violation.
  local out="$FIX_DIR/railway-floating-uses.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
      - name: Install Railway CLI
        run: npm i -g @railway/cli@5.20.0
YAML
  printf '%s' "$out"
}

write_railway_cli_latest() {
  local out="$FIX_DIR/railway-cli-latest.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: npm i -g @railway/cli@latest
YAML
  printf '%s' "$out"
}

# PR #78 round-1 security-reviewer LOW#6 — tightened detector must
# reject every floating dist-tag, not just @latest. Two new fixtures
# cover @beta and @next; the prior shape would have passed both
# silently because `grep -vE '@[0-9]'` only filtered out
# digit-prefixed versions, leaving any alphabetic dist-tag through.
write_railway_cli_beta() {
  local out="$FIX_DIR/railway-cli-beta.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: npm i -g @railway/cli@beta
YAML
  printf '%s' "$out"
}

write_railway_cli_next() {
  local out="$FIX_DIR/railway-cli-next.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: npm i -g @railway/cli@next
YAML
  printf '%s' "$out"
}

write_railway_curl_sh() {
  local out="$FIX_DIR/railway-curl-sh.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: curl -fsSL https://railway.app/install.sh | sh
YAML
  printf '%s' "$out"
}

write_railway_bare_npm() {
  # Bare `npm i -g <pkg>` with no `@<version>` — implicit @latest.
  local out="$FIX_DIR/railway-bare-npm.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: npm i -g @railway/cli
YAML
  printf '%s' "$out"
}

# Comments-only file — proves comments documenting the closed surfaces
# (e.g. "Replacing it with `curl | sh` reopens the hazard") do NOT
# self-match. This is the regression that originally surfaced in the
# author's local run.
write_railway_comments_only_describing_closed_surfaces() {
  local out="$FIX_DIR/railway-comments-describing-closed.yml"
  cat > "$out" <<'YAML'
name: deploy-railway
# Replacing it with `curl | sh` or `@latest` reopens the unpinned hazard.
# A `npm i -g something@latest` would also trip the gate.
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - name: Install Railway CLI
        run: npm i -g @railway/cli@5.20.0
YAML
  printf '%s' "$out"
}

write_migration_pinned() {
  # deploy-migrations shape: SHA-pinned uses + version-pinned setup-cli, no
  # `npm i -g`. The GREEN baseline for the migration flag.
  local out="$FIX_DIR/migration-pinned.yml"
  cat > "$out" <<'YAML'
name: deploy-migrations
on:
  workflow_dispatch:
jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: supabase/setup-cli@3c2f5e2ae34c34e428e8e206e2c4d21fa2d20fbf # v2.1.1
        with:
          version: 2.107.0
      - name: Apply
        run: supabase db push --yes
YAML
  printf '%s' "$out"
}

write_migration_floating_uses() {
  # Regress only the setup-cli ref to a floating @v2.1.1 tag — the detector
  # must surface it once ENABLE_MIGRATION_DEPLOY=true.
  local out="$FIX_DIR/migration-floating-uses.yml"
  cat > "$out" <<'YAML'
name: deploy-migrations
on:
  workflow_dispatch:
jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: supabase/setup-cli@v2.1.1
        with:
          version: 2.107.0
      - name: Apply
        run: supabase db push --yes
YAML
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

RAILWAY_PINNED=$(write_railway_pinned)
VERCEL_PINNED=$(write_vercel_pinned)
RAILWAY_FLOATING_USES=$(write_railway_floating_uses)
RAILWAY_CLI_LATEST=$(write_railway_cli_latest)
RAILWAY_CLI_BETA=$(write_railway_cli_beta)
MIGRATION_PINNED=$(write_migration_pinned)
MIGRATION_FLOATING_USES=$(write_migration_floating_uses)
RAILWAY_CLI_NEXT=$(write_railway_cli_next)
RAILWAY_CURL_SH=$(write_railway_curl_sh)
RAILWAY_BARE_NPM=$(write_railway_bare_npm)
RAILWAY_COMMENTS=$(write_railway_comments_only_describing_closed_surfaces)

echo "=== GREEN — flags unset / unarmed ==="
run_case \
  "both flags unset → exit 0" \
  "" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

run_case \
  "both flags 'false' (non-true) → exit 0" \
  "false" "false" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

run_case \
  "railway armed + railway pinned, vercel unset → exit 0" \
  "true" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

run_case \
  "both armed + both pinned correctly → exit 0" \
  "true" "true" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

run_case \
  "comments mentioning the closed surfaces do not self-match" \
  "true" "" \
  "$RAILWAY_COMMENTS" "$VERCEL_PINNED" \
  0

echo ""
echo "=== RED — armed flag + regressed pin ==="

run_case \
  "railway armed + floating uses:@v4 → exit 1" \
  "true" "" \
  "$RAILWAY_FLOATING_USES" "$VERCEL_PINNED" \
  1 \
  "floating \`uses:\` action ref"

run_case \
  "railway armed + CLI @latest → exit 1" \
  "true" "" \
  "$RAILWAY_CLI_LATEST" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

# LOW#6 — tightened positive allowlist. @beta and @next would have
# silently passed the prior `grep -vE '@[0-9]'` filter.
run_case \
  "railway armed + CLI @beta → exit 1 (dist-tag, not semver)" \
  "true" "" \
  "$RAILWAY_CLI_BETA" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

run_case \
  "railway armed + CLI @next → exit 1 (dist-tag, not semver)" \
  "true" "" \
  "$RAILWAY_CLI_NEXT" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

run_case \
  "railway armed + curl|sh CLI install → exit 1" \
  "true" "" \
  "$RAILWAY_CURL_SH" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

run_case \
  "railway armed + bare npm i -g (no @version) → exit 1" \
  "true" "" \
  "$RAILWAY_BARE_NPM" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

echo ""
echo "=== RED — flag armed, workflow missing ==="
run_case \
  "railway armed but file missing → exit 1" \
  "true" "" \
  "$FIX_DIR/does-not-exist.yml" "$VERCEL_PINNED" \
  1 \
  "is missing"

echo ""
echo "=== Symmetry: vercel-side flag ==="
run_case \
  "vercel armed + vercel pinned, railway unset → exit 0" \
  "" "true" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

# Build a Vercel fixture with a floating tag to prove the vercel side
# is wired symmetrically.
VERCEL_FLOATING="$FIX_DIR/vercel-floating-uses.yml"
cat > "$VERCEL_FLOATING" <<'YAML'
name: deploy-vercel
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: pnpm/action-setup@v4
      - name: Install Vercel CLI
        run: npm i -g vercel@54.14.5
YAML
run_case \
  "vercel armed + floating pnpm/action-setup@v4 → exit 1" \
  "" "true" \
  "$RAILWAY_PINNED" "$VERCEL_FLOATING" \
  1 \
  "floating \`uses:\` action ref"

echo ""
echo "=== In-job re-check path (LOW#5) ==="
# The deploy workflows pass `env: ENABLE_RAILWAY_DEPLOY: 'true'` (literal)
# regardless of the upstream `vars.ENABLE_*` state, so the pin check fires
# on every deploy job execution — including workflow_dispatch and any
# other future trigger that bypasses the upstream ENABLE_* variable.
# These assertions pin both directions of that contract: the script
# behaves identically whether the 'true' arrived via vars.ENABLE_* or via
# the in-job env override; pin regressions are caught either way.

run_case \
  "in-job ENABLE_RAILWAY_DEPLOY='true' + pinned → exit 0 (GREEN)" \
  "true" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

run_case \
  "in-job ENABLE_RAILWAY_DEPLOY='true' + @beta CLI → exit 1 (RED, dist-tag bypass closed)" \
  "true" "" \
  "$RAILWAY_CLI_BETA" "$VERCEL_PINNED" \
  1 \
  "unpinned CLI install"

run_case \
  "in-job ENABLE_VERCEL_DEPLOY='true' + pinned → exit 0 (GREEN)" \
  "" "true" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

# --- Migration flag (deploy-migrations.yml) ---------------------------------
# MIG_ENABLE / MIG_FILE feed the optional migration overrides in run_case.

MIG_ENABLE="true" MIG_FILE="$MIGRATION_PINNED" run_case \
  "ENABLE_MIGRATION_DEPLOY='true' + pinned migration workflow → exit 0 (GREEN)" \
  "" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  0

MIG_ENABLE="true" MIG_FILE="$MIGRATION_FLOATING_USES" run_case \
  "ENABLE_MIGRATION_DEPLOY='true' + floating uses: in migration workflow → exit 1 (RED)" \
  "" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  1 \
  "floating"

MIG_ENABLE="true" MIG_FILE="$FIX_DIR/does-not-exist.yml" run_case \
  "ENABLE_MIGRATION_DEPLOY='true' + missing migration workflow → exit 1 (RED)" \
  "" "" \
  "$RAILWAY_PINNED" "$VERCEL_PINNED" \
  1 \
  "is missing"

echo ""
echo "----------------------------------------"
echo "passed: ${pass_count}"
echo "failed: ${fail_count}"
if [ "$fail_count" -ne 0 ]; then
  exit 1
fi
exit 0
