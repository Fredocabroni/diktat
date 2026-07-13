#!/usr/bin/env bash
#
# Production health probe — auth-free, no browser, no secrets.
#
# Hits LIVE production and asserts the surfaces that a DEPLOY-LESS config
# drift (rotated/incorrect Supabase key, unapplied migration or grant, a
# dead route) would break with NO code change shipping — the exact failure
# mode that hid a `tribes.list` 500 in prod behind a green CI (PHASE 3).
# CI tests a build; this tests reality.
#
# Checks (ALL run every invocation so every failure surfaces in one run):
#   1. GET  $API_BASE/health                         → 200 + body has "status":"ok"
#   2. GET  $API_BASE/trpc/tribes.list?batch=1&...    → 200 + tribes array NON-EMPTY
#      (THE flagship assertion: a zero-length array OR a resolver 500 is the
#       precise shape of the bug that went unnoticed.)
#   3. GET  $WEB_BASE             (follow redirects)  → final 200 [+ host]
#   4. GET  $WEB_BASE/onboard/tribe (follow redir.)   → final 200 [+ host]
#
# The apex host 308-redirects to www (diktat.org → www.diktat.org); the web
# checks follow redirects (-L) and assert the FINAL status, so the canonical-
# host hop is not a false failure. They ALSO assert the final host equals
# $EXPECT_WEB_HOST (default www.diktat.org) — this catches a domain/DNS
# misconfig that happens to 200 on the WRONG host. Set EXPECT_WEB_HOST='' to
# skip the host assertion (e.g. when pointing WEB_BASE at a preview URL).
#
# Bases are overridable for staging / preview / local runs:
#   API_BASE        (default https://api.diktat.org)
#   WEB_BASE        (default https://diktat.org)
#   EXPECT_WEB_HOST (default www.diktat.org; empty string disables host check)
#
# Each check retries up to $ATTEMPTS on transport failure or a 5xx, so a
# single dropped packet on a 30-minute cron does not page. A check fails
# only when EVERY attempt fails — a persistent 500 (the PHASE 3 outage)
# still fails red.
#
# Outcome contract:
#   exit 0 — every check passed.
#   exit 1 — at least one check failed; each failure emits a GitHub
#            `::error::` annotation naming the check + reason.
#   exit 2 — harness/setup error (missing jq).
#
# Invocation (from .github/workflows/health-probe.yml, or locally):
#   bash .github/scripts/check-prod-health.sh

set -uo pipefail

API_BASE="${API_BASE:-https://api.diktat.org}"
WEB_BASE="${WEB_BASE:-https://diktat.org}"
EXPECT_WEB_HOST="${EXPECT_WEB_HOST-www.diktat.org}"

CONNECT_TIMEOUT=10
MAX_TIME=20
ATTEMPTS=3
RETRY_SLEEP=5
UA="diktat-health-probe (github-actions; +https://github.com/Fredocabroni/diktat)"

# jq parses the one JSON assertion (tribes array length). It is preinstalled
# on ubuntu-latest. Guard explicitly so a missing jq fails LOUDLY as a setup
# error rather than silently mis-reporting "empty tribes".
if ! command -v jq >/dev/null 2>&1; then
  printf '::error::health-probe: jq is required but not installed\n' >&2
  exit 2
fi

exit_code=0
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

fail() {
  printf '::error::health-probe: %s — %s\n' "$1" "$2"
  printf 'FAIL  %s — %s\n' "$1" "$2" >&2
  exit_code=1
}
pass() { printf 'PASS  %s\n' "$1"; }

# host_of <url> — extract the host from a URL (strip scheme, path, port).
host_of() {
  local u="${1#*://}"   # drop scheme://
  u="${u%%/*}"          # drop /path
  printf '%s' "${u%%:*}" # drop :port
}

# http_request <url> [extra curl args...] — perform the request (following
# -L redirects) and set two globals:
#   HTTP_CODE           final HTTP status ("000" on transport failure)
#   HTTP_EFFECTIVE_URL  final URL after redirects
# Body is written to $BODY_FILE. Retries on transport failure (000) or 5xx;
# that is where a transient blip and a real outage diverge.
HTTP_CODE="000"
HTTP_EFFECTIVE_URL=""
http_request() {
  local url="$1"; shift
  local out attempt
  HTTP_CODE="000"; HTTP_EFFECTIVE_URL=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    out=$(curl -sS -L \
      --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
      -A "$UA" -o "$BODY_FILE" -w '%{http_code} %{url_effective}' \
      "$@" "$url" 2>/dev/null) || out="000 "
    HTTP_CODE="${out%% *}"
    HTTP_EFFECTIVE_URL="${out#* }"
    if [ "$HTTP_CODE" != "000" ] && [ "${HTTP_CODE:0:1}" != "5" ]; then break; fi
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$RETRY_SLEEP"
  done
}

# check_web <label> <url> — assert final 200 and (unless disabled) that the
# final host equals $EXPECT_WEB_HOST.
check_web() {
  local label="$1" url="$2" host
  http_request "$url"
  if [ "$HTTP_CODE" != "200" ]; then
    fail "$label" "expected final 200, got $HTTP_CODE"
    return
  fi
  if [ -n "$EXPECT_WEB_HOST" ]; then
    host=$(host_of "$HTTP_EFFECTIVE_URL")
    if [ "$host" != "$EXPECT_WEB_HOST" ]; then
      fail "$label" "final host '$host' != expected '$EXPECT_WEB_HOST' ($HTTP_EFFECTIVE_URL)"
      return
    fi
  fi
  pass "$label"
}

# --- Check 1: API /health ----------------------------------------------------
name="api /health"
http_request "$API_BASE/health"
if [ "$HTTP_CODE" != "200" ]; then
  fail "$name" "expected 200, got $HTTP_CODE"
elif ! grep -q '"status":"ok"' "$BODY_FILE"; then
  fail "$name" "200 but body missing \"status\":\"ok\""
else
  pass "$name"
fi

# --- Check 2: tribes.list NON-EMPTY (flagship) -------------------------------
name="api tribes.list non-empty"
http_request "$API_BASE/trpc/tribes.list?batch=1&input=%7B%7D"
if [ "$HTTP_CODE" != "200" ]; then
  fail "$name" "expected 200, got $HTTP_CODE (resolver/DB failure — the PHASE 3 shape)"
else
  # tRPC batch envelope; tribes array at [0].result.data.json (superjson).
  count=$(jq -r '.[0].result.data.json | length' "$BODY_FILE" 2>/dev/null || printf 'ERR')
  if ! printf '%s' "$count" | grep -qE '^[0-9]+$'; then
    fail "$name" "could not parse tribes array (body: $(head -c 120 "$BODY_FILE"))"
  elif [ "$count" -lt 1 ]; then
    fail "$name" "tribes array is EMPTY — picker would render no options"
  else
    pass "$name ($count tribes)"
  fi
fi

# --- Check 3 & 4: web -------------------------------------------------------
check_web "web /" "$WEB_BASE"
check_web "web /onboard/tribe" "$WEB_BASE/onboard/tribe"

# --- Summary -----------------------------------------------------------------
if [ "$exit_code" -eq 0 ]; then
  printf '\nhealth-probe: all checks passed\n'
else
  printf '\nhealth-probe: FAILURES detected (see ::error:: annotations)\n' >&2
fi
exit "$exit_code"
