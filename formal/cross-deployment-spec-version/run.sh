#!/usr/bin/env bash
# Re-run every formal model in this directory and compare each result file's
# verdict with expected-verdicts.txt.
#
#   ./run.sh                      all models
#   ./run.sh MidRunRaiseGates ... only the named models
#
# Models: StartStamping ServerRaiseProtocol MidRunRaiseGates ResolveLean
#         Completeness
#
# Requirements
#   Java 11+ on PATH (or JAVA=/path/to/java).
#   TLA+ tools: TLA2TOOLS=/path/to/tla2tools.jar. If unset, tla2tools v1.7.4
#     (TLC 2.19, the version the results were produced with) is downloaded
#     once to ${XDG_CACHE_HOME:-~/.cache}/workflow-formal/ and checksummed.
#   Lean 4.34.1 via elan (the lean-toolchain file here pins it), or
#     LEAN=/path/to/lean. Core Lean only; no Mathlib, no Lake.
#
# Other knobs
#   JOBS=N        models run in parallel (default 1). Each TLC run uses 2
#                 workers and a 2 GB heap, so JOBS=5 wants ~8 cores and 12 GB.
#   WORKERS=N     TLC workers per run (default 2).
#   TLC_TIMEOUT=s per TLC run (default 900). ServerRaiseProtocol has runs of
#                 a few minutes each; the whole suite takes about 2 h 45 min
#                 serially, 1 h 46 min with JOBS=5 (bounded by
#                 ServerRaiseProtocol).
#
# Output
#   <Model>/results/*.txt   full TLC / Lean output, rewritten by the run
#   results/verdicts.txt    one verdict per result file (verdicts.py)
#   results/<Model>.log     the model's own run.sh log
#   Exit status 0 iff every verdict matches expected-verdicts.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
ALL_MODELS=(StartStamping ServerRaiseProtocol MidRunRaiseGates ResolveLean Completeness)
if [ $# -gt 0 ]; then MODELS=("$@"); else MODELS=("${ALL_MODELS[@]}"); fi
JOBS="${JOBS:-1}"
export WORKERS="${WORKERS:-2}" TLC_WORKERS="${WORKERS:-2}"
export TLC_TIMEOUT="${TLC_TIMEOUT:-900}"
export JAVA="${JAVA:-java}"

die() { echo "run.sh: $*" >&2; exit 2; }

# --- Java ---------------------------------------------------------------
command -v "$JAVA" >/dev/null 2>&1 || die "java not found (set JAVA=...)"
jv="$("$JAVA" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+)(\.[0-9]+)?.*/\1/')"
if [ "$jv" = 1 ]; then jv=8; fi
[ "${jv:-0}" -ge 11 ] 2>/dev/null || die "Java 11+ required (got: $("$JAVA" -version 2>&1 | head -1))"

# --- TLA+ tools ---------------------------------------------------------
TLA_VERSION=v1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
if [ -z "${TLA2TOOLS:-}" ]; then
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/workflow-formal"
  TLA2TOOLS="$cache/tla2tools-$TLA_VERSION.jar"
  if [ ! -f "$TLA2TOOLS" ]; then
    mkdir -p "$cache"
    echo "downloading tla2tools $TLA_VERSION to $TLA2TOOLS"
    curl -fsSL -o "$TLA2TOOLS.part" \
      "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar" \
      || die "download of tla2tools.jar failed"
    got="$(sha256sum "$TLA2TOOLS.part" | cut -d' ' -f1)"
    [ "$got" = "$TLA_SHA256" ] || { rm -f "$TLA2TOOLS.part"; die "tla2tools.jar checksum mismatch ($got)"; }
    mv "$TLA2TOOLS.part" "$TLA2TOOLS"
  fi
fi
[ -f "$TLA2TOOLS" ] || die "TLA2TOOLS=$TLA2TOOLS does not exist"
export TLA2TOOLS

# --- Lean ---------------------------------------------------------------
if [ -z "${LEAN:-}" ]; then
  LEAN="$(command -v lean || true)"
  [ -n "$LEAN" ] || LEAN="$HOME/.elan/bin/lean"
fi
needs_lean=0
for m in "${MODELS[@]}"; do case $m in ResolveLean|Completeness) needs_lean=1;; esac; done
if [ $needs_lean = 1 ]; then
  [ -x "$LEAN" ] || die "lean not found (install elan, or set LEAN=...)"
  "$LEAN" --version | grep -q "4\.34" || echo "warning: expected Lean 4.34.x, got: $("$LEAN" --version)" >&2
fi
export LEAN

echo "java:      $("$JAVA" -version 2>&1 | head -1)"
echo "tla2tools: $TLA2TOOLS"
[ $needs_lean = 1 ] && echo "lean:      $("$LEAN" --version)"
echo "models:    ${MODELS[*]} (JOBS=$JOBS, WORKERS=$WORKERS)"
echo

mkdir -p results
run_model() {
  local m="$1" start end rc
  [ -x "$m/run.sh" ] || [ -f "$m/run.sh" ] || { echo "no such model: $m" >&2; return 2; }
  start=$(date +%s)
  echo "[$(date -u +%H:%M:%S)] start $m"
  bash "$m/run.sh" > "results/$m.log" 2>&1
  rc=$?
  end=$(date +%s)
  echo "[$(date -u +%H:%M:%S)] done  $m (run.sh exit $rc, $(( (end - start) / 60 ))m$(( (end - start) % 60 ))s)"
}

running=0
for m in "${MODELS[@]}"; do
  if [ "$JOBS" -le 1 ]; then run_model "$m"; else
    run_model "$m" &
    running=$((running + 1))
    if [ $running -ge "$JOBS" ]; then wait -n; running=$((running - 1)); fi
  fi
done
wait

# --- Summary ------------------------------------------------------------
python3 verdicts.py results/verdicts.txt
status=0
echo
printf '%-22s %6s %6s %9s %7s %8s %9s\n' model files pass violation proved errors mismatch
for m in "${MODELS[@]}"; do
  exp="$(grep "^$m/" expected-verdicts.txt | sort)"
  got="$(grep "^$m/" results/verdicts.txt | sort)"
  mism="$(diff <(echo "$exp") <(echo "$got") | grep -c '^[<>]')"
  cnt() { echo "$got" | grep -c " $1" ; }
  printf '%-22s %6s %6s %9s %7s %8s %9s\n' "$m" "$(echo "$got" | grep -c .)" \
    "$(cnt PASS)" "$(cnt VIOLATION)" "$(cnt PROVED)" \
    "$(echo "$got" | grep -cE ' (ERROR|FAILED)')" "$mism"
  if [ "$mism" != 0 ]; then
    status=1
    diff <(echo "$exp") <(echo "$got") | grep '^[<>]' | sed 's/^</  expected:/; s/^>/  got:     /'
  fi
done
echo
if [ $status = 0 ]; then echo "all verdicts match expected-verdicts.txt"
else echo "MISMATCH against expected-verdicts.txt (see above and results/<Model>.log)"; fi
exit $status
