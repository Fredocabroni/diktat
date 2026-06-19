#!/usr/bin/env bash
#
# Reviewer gate-integrity check. Decides whether `claude -p`'s output
# is a real review, a legitimate "no files in scope" empty, or an
# upstream API failure that the prior `|| true` shape silently
# green-stamped onto the merge gate.
#
# Usage:
#   check-review-output.sh <output-file> <claude-exit-code>
#
# Outcome contract:
#   exit 0 + stdout "ok"    — real review (caller posts the body).
#   exit 0 + stdout "empty" — legitimate no-scope (caller skips post).
#   exit 1 + stderr ::error — upstream failure (caller posts body for
#                              visibility AND fails the workflow job).
#
# Detection — two independent gates, both must pass:
#
#   (1) Primary: claude -p's exit code must be 0. A crash, OOM, or
#       network failure that produces no stdout currently passes as
#       "no scope" — capturing the exit code closes that hole.
#
#   (2) Secondary: on exit 0, the first ~10 non-blank lines must
#       contain at least one ATX markdown header (1-6 leading `#`
#       followed by whitespace). The Anthropic CLI sometimes prints
#       error messages to stdout and exits 0 anyway — the credit-
#       balance shape that triggered this work (PRs #48, #49, #50).
#       Scanning a window rather than the single first line is
#       necessary because real reviews legitimately lead with `---`
#       horizontal-rule dividers before the header (observed on the
#       PR #46 copy-linter body).
#
# Error-string matching exists ONLY to improve the failure message
# (e.g. "credit exhausted, top up at console.anthropic.com"). Detection
# itself is gate-based — anything that lacks a markdown header in the
# scan window fails, regardless of whether we recognize the error
# string.

set -euo pipefail

file="${1:?path to review output file required}"
claude_exit_code="${2:?claude exit code required}"

# Maximum non-blank lines scanned for the ATX header. Tuned for
# legitimate frontmatter / divider prefixes; small enough that
# garbage bodies fail fast.
HEADER_SCAN_LINES=10

diagnose() {
  local prefix="$1"
  local body detail first
  body=$(cat "$file" 2>/dev/null || echo "")
  case "$body" in
    "")
      detail="empty output"
      ;;
    *"Credit balance is too low"*)
      detail="Anthropic API credit exhausted on the GHA key. Top up at https://console.anthropic.com → Plans & Billing, then re-run the workflow."
      ;;
    *"rate_limit"*|*"Rate limit"*)
      detail="rate-limited by Anthropic API. Retry the workflow shortly."
      ;;
    *"overloaded"*|*"Overloaded"*)
      detail="Anthropic API overloaded. Retry the workflow shortly."
      ;;
    *"internal_server_error"*|*"Internal server error"*)
      detail="Anthropic API internal error. Retry the workflow shortly."
      ;;
    *)
      first=$(awk 'NF{print; exit}' "$file" 2>/dev/null || echo "")
      detail="agent emitted non-review content (no markdown header in first ${HEADER_SCAN_LINES} non-blank lines). First line: $first"
      ;;
  esac
  echo "::error::Reviewer gate failed [${prefix}]: ${detail}" >&2
}

# ----------------------------------------------------------------------
# (1) Primary gate: non-zero claude exit is a hard fail.
# ----------------------------------------------------------------------
if [ "$claude_exit_code" != "0" ]; then
  diagnose "claude -p exited ${claude_exit_code}"
  exit 1
fi

# ----------------------------------------------------------------------
# Legitimate empty / whitespace-only: caller skips the post. This is
# what copy-linter looks like on a migration-only PR with no
# apps/web/**/*.tsx changes — the agent has nothing to say.
# ----------------------------------------------------------------------
if [ ! -s "$file" ] || [ -z "$(tr -d '[:space:]' < "$file")" ]; then
  echo "empty"
  exit 0
fi

# ----------------------------------------------------------------------
# (2) Secondary gate: ATX header in the scan window.
#
# Implementation note — pure awk, no pipe. A `grep | head -1` shape
# (or equivalently `awk | head`) would close the pipe early on a
# match; head's exit closes the pipe; the upstream gets SIGPIPE; under
# `set -o pipefail` the whole script then exits non-zero on the
# SUCCESS path of a large real review. Single awk: no pipe to break.
# ----------------------------------------------------------------------
header_line=$(awk -v limit="$HEADER_SCAN_LINES" '
  /^[[:space:]]*$/ { next }       # skip blank lines from the window
  ++n > limit { exit }            # bail after scan-window exhausted
  /^#{1,6}[[:space:]]/ {          # ATX header: 1-6 # then whitespace
    print
    exit
  }
' "$file")

if [ -n "$header_line" ]; then
  echo "ok"
  exit 0
fi

diagnose "claude -p exit 0 but no markdown header in first ${HEADER_SCAN_LINES} non-blank lines"
exit 1
