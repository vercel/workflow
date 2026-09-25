#!/usr/bin/env bash
# Re-runs every TLC check for the ServerRaiseProtocol model.
#
#   ./run.sh              # regenerate cfgs, then every config: safety run,
#                         # per-property isolation runs, progress run
#   ./run.sh CURRENT ...  # just these configs (safety + progress runs only)
#
# Env overrides:
#   TLA2TOOLS  path to tla2tools.jar (default ~/.local/opt/tla2tools.jar)
#   JAVA       java binary (default: java)
#   WORKERS    TLC workers (default 2)
#   TLC_TIMEOUT seconds per run (default 900)
#   XMX        JVM heap (default 2g)
#   ISOLATE=1  with named configs, also run the per-property isolation runs
#
# #1044 @ f83173c (HEAD*), the pre-PR reference (MAIN*) and the 9159765
# regression witness (H9159765) are generated with the rest; to rerun only
# them with the isolation runs:
#   ISOLATE=1 WORKERS=3 XMX=3g TLC_TIMEOUT=2400 \
#     ./run.sh H9159765 $(python3 gen_cfgs.py | grep -E '^(HEAD|MAIN)') RECOMMENDED
#
# Condensed traces: python3 summarize_trace.py results/<file>.txt
#
# Output per config <c>:
#   results/<c>.txt              SAFETY: <c>.cfg as generated (BoundedLatency
#                                = FALSE, every interleaving), all safety
#                                invariants + action properties together
#                                (TLC stops at the first violation).
#   results/<c>__<Prop>.txt      each safety invariant / action property on
#                                its own (own shortest counterexample or pass),
#                                plus the informational invariants.
#   results/<c>__PROGRESS.txt    PROGRESS: BoundedLatency = TRUE, FairSpec,
#                                NoStuck + GoodOutcome + Termination (<>AllDone).
# plus results/RECOMMENDED__PROGRESS_noBL.txt: the progress run without the
# timing assumption, showing why it is needed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TLA2TOOLS="${TLA2TOOLS:-$HOME/.local/opt/tla2tools.jar}"
JAVA="${JAVA:-java}"
WORKERS="${WORKERS:-2}"
TLC_TIMEOUT="${TLC_TIMEOUT:-900}"
XMX="${XMX:-2g}"
RESULTS="$HERE/results"
mkdir -p "$RESULTS"

tlc() { # <dir> <cfg> <out>
  (cd "$1" && timeout "$TLC_TIMEOUT" "$JAVA" -XX:+UseParallelGC -Xmx"$XMX" \
     -cp "$TLA2TOOLS" tlc2.TLC -workers "$WORKERS" -metadir "$1/states" \
     -config "$2" ServerRaiseProtocol.tla) > "$3" 2>&1
  local rc=$?
  local verdict
  if grep -q "No error has been found" "$3"; then verdict=PASS
  elif grep -q "is violated" "$3"; then verdict="VIOLATION ($(grep -m1 -oE '[A-Za-z]+ is violated' "$3"))"
  elif grep -q "Temporal properties were violated" "$3"; then verdict="VIOLATION (Termination)"
  else verdict="ERROR (exit $rc)"; fi
  printf '%-58s %s\n' "$(basename "$3")" "$verdict"
}

# <src cfg> <dst cfg> <BoundedLatency TRUE|FALSE>: progress-run cfg
progress_cfg() {
  sed -e '/^INVARIANTS/,$d' -e 's/^SPECIFICATION Spec/SPECIFICATION FairSpec/' \
      -e "s/^  BoundedLatency = .*/  BoundedLatency = $3/" "$1" > "$2"
  printf 'INVARIANTS\n  NoStuck\n  GoodOutcome\nPROPERTIES\n  Termination\nCHECK_DEADLOCK FALSE\n' >> "$2"
}

if [ $# -gt 0 ]; then
  CONFIGS=("$@"); ONLY_HEADLINE=1
  [ "${ISOLATE:-0}" = 1 ] && ONLY_HEADLINE=0
else
  mapfile -t CONFIGS < <(cd "$HERE" && python3 gen_cfgs.py); ONLY_HEADLINE=0
fi

INVARIANTS=(NoMixedIdentityLog ExecutorReadable RunCreatedPresent
            RunCreatedFirstAndUnique RunCreatedSpecMatchesRow NoDoomedRun
            SpecNeverLowered ReplayNeverFails NoStuck
            RunCreatedFirstAndUniqueStrict AtMostOneRunStarted)
PROPERTIES=(SpecMonotonic NoStructuralCrossAfterFirstNonCreatedEvent
            TerminalIsFinal)

for cfg in "${CONFIGS[@]}"; do
  tmp="$(mktemp -d)"
  cp "$HERE/ServerRaiseProtocol.tla" "$HERE/$cfg.cfg" "$tmp/"
  tlc "$tmp" "$cfg.cfg" "$RESULTS/$cfg.txt"
  if [ "$ONLY_HEADLINE" = 0 ] && [ "$cfg" != RECOMMENDED_D3 ]; then
    for kind in INVARIANT PROPERTY; do
      if [ $kind = INVARIANT ]; then names=("${INVARIANTS[@]}"); else names=("${PROPERTIES[@]}"); fi
      for p in "${names[@]}"; do
        sed -e '/^INVARIANTS/,$d' "$HERE/$cfg.cfg" > "$tmp/iso.cfg"
        printf '%s\n  %s\nCHECK_DEADLOCK FALSE\n' "$kind" "$p" >> "$tmp/iso.cfg"
        tlc "$tmp" iso.cfg "$RESULTS/${cfg}__${p}.txt"
      done
    done
  fi
  progress_cfg "$HERE/$cfg.cfg" "$tmp/progress.cfg" TRUE
  tlc "$tmp" progress.cfg "$RESULTS/${cfg}__PROGRESS.txt"
  if [ "$cfg" = RECOMMENDED ]; then
    progress_cfg "$HERE/$cfg.cfg" "$tmp/progress_nobl.cfg" FALSE
    tlc "$tmp" progress_nobl.cfg "$RESULTS/${cfg}__PROGRESS_noBL.txt"
  fi
  rm -rf "$tmp"
done
