#!/usr/bin/env bash
#
# Activation-safety gate. The deploy-workflow hardening bundle pinned every
# `uses: <action>@...` ref to a 40-char commit SHA and every CLI install to
# an exact version (no @latest). This script mechanically enforces that
# those pins do not regress at the moment they matter most: when
# `vars.ENABLE_RAILWAY_DEPLOY` or `vars.ENABLE_VERCEL_DEPLOY` is set to
# 'true' on the repo. While the flags stay unset (deploy jobs skip) this
# script is trivially green — the cost of running it is irrelevant.
#
# Closes the round-2 reviewer's structural complaint on PR #71: "a queue
# entry is not a CI gate." There is now a CI gate.
#
# Invocation (from .github/workflows/ci.yml's verify job):
#   ENABLE_RAILWAY_DEPLOY=${{ vars.ENABLE_RAILWAY_DEPLOY }} \
#   ENABLE_VERCEL_DEPLOY=${{ vars.ENABLE_VERCEL_DEPLOY }} \
#       bash .github/scripts/check-activation-safety.sh
#
# A GHA `vars.<NAME>` evaluates to the empty string when the variable is
# not set — `==` 'true' comparison fails and the corresponding deploy
# check is skipped. The unset-flag → green-pass path is the dominant
# case today; the assertion paths fire only when an operator has
# explicitly armed the flag, which is exactly when we want the gate to
# refuse a regressed workflow.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Workflow paths can be overridden via env vars — used by the script's
# own RED/GREEN regression tests (see scripts/__tests__/, run from CI's
# `verify` job) so the detectors can be exercised against synthetic
# floating-tag / @latest fixtures without mutating the real deploy
# workflow files. Production CI invocation leaves these unset and the
# defaults take effect.
RAILWAY_WORKFLOW="${RAILWAY_WORKFLOW_FILE:-${REPO_ROOT}/.github/workflows/deploy-railway.yml}"
VERCEL_WORKFLOW="${VERCEL_WORKFLOW_FILE:-${REPO_ROOT}/.github/workflows/deploy-vercel.yml}"

ENABLE_RAILWAY_DEPLOY="${ENABLE_RAILWAY_DEPLOY:-}"
ENABLE_VERCEL_DEPLOY="${ENABLE_VERCEL_DEPLOY:-}"

# Internal: flips to 1 on the first failure; the script exits with this
# code at the end so all violations across both workflows surface in one
# CI run instead of trickling out one fix at a time.
exit_code=0

# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------
#
# floating_uses <workflow-file>
#   Returns 0 (found) when the file contains any `uses: <action>@<ref>`
#   line where <ref> is NOT a 40-character lowercase hex string (i.e. NOT
#   a commit SHA). The acceptable shape is the SHA-pinned form used
#   throughout this repo:
#       uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
#   Anything else — `@v4`, `@v4.2.2`, `@main`, `@latest` — is a floating
#   tag and a failure. Prints the matching lines to stderr.
#
# unpinned_cli <workflow-file>
#   Returns 0 (found) when the file contains any `npm i -g <pkg>@latest`
#   shape or a bare `npm i -g <pkg>` with no version pin. Prints the
#   matching lines to stderr.

# YAML comment lines (`#` as the first non-whitespace char) are stripped
# before pattern matching — the workflow files document the pin
# requirements in inline comments that would otherwise self-match the
# detection regexes. Inline trailing comments (`uses: foo@sha # v4.2.2`)
# are not affected because they don't start the line.
strip_yaml_comments() {
  grep -vE '^[[:space:]]*#' "$1"
}

floating_uses() {
  local file="$1"
  # `grep -E` returns 0 on at least one match. Looking for `uses: foo@bar`
  # lines where `bar` is NOT 40 hex chars. We extract the ref portion and
  # validate via a second filter rather than a single regex (cleaner).
  local matches
  matches=$(strip_yaml_comments "$file" \
    | grep -nE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^[:space:]]+@[^[:space:]]+' \
    || true)
  if [ -z "$matches" ]; then
    return 1
  fi
  local violations=""
  while IFS= read -r line; do
    # Extract the segment after the last `@` up to whitespace or end-of-line.
    # Example: "      - uses: actions/checkout@11bd71... # v4.2.2"
    # ref = "11bd71..." (then `# v4.2.2` is a comment, ignored).
    local ref
    ref=$(printf '%s' "$line" | sed -E 's/.*@([^[:space:]#]+).*/\1/')
    # 40-character lowercase hex is the accepted SHA-pinned shape.
    if ! printf '%s' "$ref" | grep -qE '^[0-9a-f]{40}$'; then
      violations+="$line"$'\n'
    fi
  done <<<"$matches"
  if [ -n "$violations" ]; then
    printf '%s' "$violations" >&2
    return 0
  fi
  return 1
}

unpinned_cli() {
  local file="$1"
  # Positive allowlist for CLI installs — flips the earlier negative-list
  # shape that only rejected known-bad patterns (PR #78 round-1
  # security-reviewer LOW#6). A CLI install is OK only when the version
  # suffix matches semver: `<pkg>@<MAJOR>.<MINOR>...` where MAJOR and MINOR
  # are numeric. Anything else fails:
  #   - `<pkg>@latest`  — floating dist-tag (caught by prior shape)
  #   - `<pkg>@beta`    — floating dist-tag (NOT caught by prior shape)
  #   - `<pkg>@next`    — floating dist-tag (NOT caught by prior shape)
  #   - `<pkg>@canary`  — floating dist-tag (NOT caught by prior shape)
  #   - bare `<pkg>`    — implicit @latest (caught by prior shape)
  # `curl | sh` is also caught as a regression guard — the deploy workflows
  # no longer use it but the detector remains in case a future edit
  # re-introduces it.
  # Comments are stripped first via strip_yaml_comments (this file's docs
  # explain the closed surfaces in plain English, which would otherwise
  # self-match).
  local stripped
  stripped="$(strip_yaml_comments "$file")"
  local violations=""
  local m
  # Match every `npm i[nstall] -g <something>` line. The trailing capture
  # is whatever comes after `-g `: a pkg name optionally followed by
  # `@<version-or-tag>`, then end-of-line / whitespace / shell-redirect
  # boundary. We then check each match against the positive semver
  # allowlist; anything that doesn't match fails.
  local installs
  installs=$(printf '%s\n' "$stripped" \
        | grep -nE 'npm[[:space:]]+i(nstall)?[[:space:]]+-g[[:space:]]+[^[:space:]]+' \
        || true)
  if [ -n "$installs" ]; then
    while IFS= read -r line; do
      # Extract the package spec after `-g `. Stops at whitespace or
      # end-of-line so trailing flags / comments don't pollute the spec.
      local spec
      spec=$(printf '%s' "$line" | sed -E 's/.*-g[[:space:]]+([^[:space:]]+).*/\1/')
      # Positive allowlist: <pkg>@<digits>.<digits>... (semver-pinned).
      # The leading <pkg> permits scoped packages (`@scope/name`) and
      # the version anchor is `@` followed by digits + dot + digit.
      if ! printf '%s' "$spec" | grep -qE '@[0-9]+\.[0-9]'; then
        violations+="$line"$'\n'
      fi
    done <<<"$installs"
  fi
  # `curl | sh` regression guard.
  m=$(printf '%s\n' "$stripped" \
        | grep -nE 'curl[[:space:]]+.*\|[[:space:]]*sh\b' \
        || true)
  [ -n "$m" ] && violations+="$m"$'\n'
  if [ -n "$violations" ]; then
    printf '%s' "$violations" >&2
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Per-flag gates
# ---------------------------------------------------------------------------

check_flag() {
  local flag_name="$1"
  local flag_value="$2"
  local workflow_file="$3"
  if [ "$flag_value" != "true" ]; then
    printf '%s=%s (flag unset or not "true") — activation-safety check skipped for %s\n' \
      "$flag_name" "$flag_value" "$(basename "$workflow_file")"
    return 0
  fi
  if [ ! -f "$workflow_file" ]; then
    printf '::error::%s=true but %s is missing\n' "$flag_name" "$workflow_file" >&2
    exit_code=1
    return 0
  fi
  printf '%s=true — verifying activation-safety pins in %s\n' \
    "$flag_name" "$(basename "$workflow_file")"
  local failed=0
  if floating_uses "$workflow_file"; then
    printf '::error::%s=true but %s contains floating `uses:` action ref(s) without a 40-char SHA pin. See the lines above.\n' \
      "$flag_name" "$(basename "$workflow_file")" >&2
    failed=1
  fi
  if unpinned_cli "$workflow_file"; then
    printf '::error::%s=true but %s contains an unpinned CLI install (@latest, bare npm i -g, or curl|sh). See the lines above.\n' \
      "$flag_name" "$(basename "$workflow_file")" >&2
    failed=1
  fi
  if [ "$failed" = 1 ]; then
    exit_code=1
  else
    printf '  → OK: every `uses:` is SHA-pinned and every CLI install is version-pinned.\n'
  fi
}

check_flag "ENABLE_RAILWAY_DEPLOY" "$ENABLE_RAILWAY_DEPLOY" "$RAILWAY_WORKFLOW"
check_flag "ENABLE_VERCEL_DEPLOY"  "$ENABLE_VERCEL_DEPLOY"  "$VERCEL_WORKFLOW"

exit "$exit_code"
