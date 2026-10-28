#!/usr/bin/env bash
# Runs a Vercel CLI command, retrying it with jittered exponential backoff when
# it fails on the Vercel API rate limit. Any other failure is returned as-is.
#
# Usage: with-rate-limit-retry.sh <command> [args...]
#
# The E2E fan-out starts dozens of these jobs at once against one token, and
# each CLI invocation queries `/teams` to resolve `--scope`, so bursts trip
# `Rate limited. Too many requests to the same endpoint: /teams` before any
# deployment is created. The command's stdout passes through untouched (callers
# capture the deployment URL from it) and its stderr streams live.
#
# RATE_LIMIT_MAX_ATTEMPTS (default 5) and RATE_LIMIT_BASE_DELAY_SECONDS
# (default 10) tune the retry; the defaults wait at most about five minutes.
set -uo pipefail

max_attempts=${RATE_LIMIT_MAX_ATTEMPTS:-5}
delay=${RATE_LIMIT_BASE_DELAY_SECONDS:-10}
stderr_log=$(mktemp)
trap 'rm -f "$stderr_log"' EXIT

for ((attempt = 1; ; attempt++)); do
  # stdout goes to fd 3 (the caller's stdout); stderr is teed to the log and
  # back to stderr. `pipefail` makes the pipeline's status the command's.
  { "$@" 2>&1 1>&3 3>&- | tee "$stderr_log" >&2; } 3>&1
  status=$?
  if ((status == 0)); then
    exit 0
  fi
  if ! grep -q 'Rate limited' "$stderr_log" || ((attempt >= max_attempts)); then
    exit "$status"
  fi
  wait_seconds=$((delay + RANDOM % (delay + 1)))
  echo "::warning::'$1 ${2:-}' hit the Vercel API rate limit (attempt $attempt of $max_attempts); retrying in ${wait_seconds}s" >&2
  sleep "$wait_seconds"
  delay=$((delay * 2))
done
