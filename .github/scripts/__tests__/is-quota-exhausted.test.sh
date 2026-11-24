#!/usr/bin/env bash
# Verify .github/scripts/is-quota-exhausted.sh distinguishes a real
# review that happens to mention quota wording from a CLI quota-
# exhausted message. Prompted by PR #344 push 1, where the first
# iteration's bare `grep usage limit` tripped on the review this PR
# itself got (the review's prose discussed the quota sentinel).
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/is-quota-exhausted.sh"
if [[ ! -x "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT missing or not executable" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

assert_quota() {
  local name="$1" file="$2"
  if "$SCRIPT" "$file"; then
    echo "  OK  $name"; pass=$((pass + 1))
  else
    echo "  FAIL  $name — expected quota=yes (exit 0), got $?"; fail=$((fail + 1))
  fi
}
assert_not_quota() {
  local name="$1" file="$2"
  if "$SCRIPT" "$file"; then
    echo "  FAIL  $name — expected quota=no (exit 1), got 0"; fail=$((fail + 1))
  else
    echo "  OK  $name"; pass=$((pass + 1))
  fi
}

# Fixture 1: real review that discusses "usage limit" and ends with
# the terminal VERDICT line. Must NOT be classified as quota.
cat > "$tmp/review-mentions-quota.md" <<'EOF'
# Security Review

The grep sentinel scans for "usage limit" in the review body and fails
the job red when it matches. This closes the quota-exhausted case where
the CLI would otherwise post its limit message as a review comment.

VERDICT: PASS
EOF

# Fixture 2: short CLI limit message with no verdict line.
cat > "$tmp/cli-limit.md" <<'EOF'
Claude usage limit reached. Please try again later.
EOF

# Fixture 3: empty file — not quota (no wording match).
: > "$tmp/empty.md"

# Fixture 4: long body without a verdict line but mentioning quota —
# ambiguous review, not a quota hit. The verdict gate handles it.
{
  printf 'Long reviewer output discussing usage limit handling.\n'
  head -c 1600 /dev/urandom | base64
} > "$tmp/long-no-verdict.md"

# Fixture 5: short wording hit WITHOUT a verdict — quota.
echo "rate limit exceeded" > "$tmp/rate-limit.md"

assert_not_quota "real review with VERDICT: PASS mentioning 'usage limit'" "$tmp/review-mentions-quota.md"
assert_quota     "short CLI 'usage limit reached' without verdict"         "$tmp/cli-limit.md"
assert_not_quota "empty file (no wording match)"                           "$tmp/empty.md"
assert_not_quota "long body without verdict (ambiguous, not quota)"        "$tmp/long-no-verdict.md"
assert_quota     "short 'rate limit' without verdict"                      "$tmp/rate-limit.md"

echo
echo "========================================"
echo "$pass passed, $fail failed"
echo "========================================"
exit "$fail"
