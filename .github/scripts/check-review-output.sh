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
#   exit 1 + stdout REASON  — upstream failure. REASON is a CONTROLLED
#                              one-line string the caller posts as the
#                              failure comment. REASON NEVER contains
#                              raw agent stdout — exfil hardening from
#                              PR #51 round-2 security-reviewer M1.
#                              The raw `$file` belongs in the workflow
#                              log only; the caller is responsible for
#                              echoing it there (not posting it as a
#                              comment).
#                              The sanitized first-line preview is
#                              ALSO emitted to stderr via an
#                              `::error::` annotation — log-only,
#                              never the comment (M2).
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
  local body body_stripped detail first reason
  body=$(cat "$file" 2>/dev/null || echo "")
  # Whitespace-only bodies should classify as "empty output" — the
  # case-match below tests against the raw `$body`, so without this
  # strip a "   \n\n   \n" file falls through to the unknown-content
  # branch on the non-zero-exit-code path. Strip once for the empty
  # check; keep the unstripped body for the error-string substring
  # matches (Postgres errors etc. may legitimately contain
  # whitespace in the middle).
  body_stripped=$(printf '%s' "$body" | tr -d '[:space:]')
  if [ -z "$body_stripped" ]; then
    detail="empty output."
  else
    case "$body" in
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
        detail="agent emitted non-review content (no markdown header in first ${HEADER_SCAN_LINES} non-blank lines)."
        ;;
    esac
  fi

  # Controlled reason — STDOUT. Written one line at a time, classified
  # message only. Caller (workflow) uses this as the failure-comment
  # body. NEVER includes raw agent content; this is the M1 exfil
  # hardening — the prior shape posted `review_output.md` directly
  # via `--body-file` on failure, which would publish anything the
  # agent (or a future hijacked subagent) wrote to stdout.
  reason="Reviewer gate failed [${prefix}]: ${detail}"
  printf '%s\n' "$reason"

  # Log-only diagnostic (STDERR via ::error:: annotation). Includes a
  # SANITIZED first-line preview from the agent body so an on-call
  # responder can see what content tripped the gate without leaving
  # the PR. Sanitization:
  #   - `tr -d '\r\n'`: strips line terminators. Without this, a
  #     malicious or accidental CR/LF in the body could synthesize
  #     additional `::error::` (or, on older runners, `::set-env::`
  #     / `::add-mask::`) workflow commands. M2 hardening.
  #   - `head -c 200`: caps annotation length so a runaway body can't
  #     flood the workflow-summary panel.
  # The preview goes to the log only — the PR comment body is the
  # controlled `reason` above, with no agent-supplied content.
  first=$(awk 'NF{print; exit}' "$file" 2>/dev/null || echo "")
  first=$(printf '%s' "$first" | tr -d '\r\n' | head -c 200)
  printf '::error::%s First line (log-only, sanitized): %s\n' "$reason" "$first" >&2
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
