#!/usr/bin/env bash
# Completeness-critic models. Reruns every check and compares with the
# expected outcome. Full outputs in results/<name>.txt.
set -u
cd "$(dirname "$0")"
JAR="${TLA2TOOLS:-$HOME/.local/opt/tla2tools.jar}"
LEAN="${LEAN:-$(command -v lean || echo "$HOME/.elan/bin/lean")}"
mkdir -p results states
fail=0
tlc() { # module cfg expected
  local out="results/$2.txt"
  rm -rf "states/$2"
  timeout "${TLC_TIMEOUT:-900}" "${JAVA:-java}" -XX:+UseParallelGC -Xmx2g -cp "$JAR" tlc2.TLC \
    -workers "${WORKERS:-2}" -deadlock -metadir "states/$2" -config "$2.cfg" "$1.tla" > "$out" 2>&1
  local got=pass
  grep -qE "is violated|Error:" "$out" && got=violation
  grep -q "Model checking completed. No error has been found" "$out" || [ $got = violation ] || got=error
  local st; st=$(grep -oE "[0-9,]+ distinct states found" "$out" | tail -1)
  printf '%-45s expected=%-9s got=%-9s %s\n' "$2" "$3" "$got" "$st"
  [ "$got" = "$3" ] || fail=1
}
lean() { # file
  local out="results/$1.txt"
  timeout 900 "$LEAN" "$1.lean" > "$out" 2>&1; local rc=$?
  echo "exit=$rc" >> "$out"
  if [ $rc -eq 0 ] && ! grep -qE "error|sorry" "$out"; then
    printf '%-45s proved (%s theorems)\n' "$1" "$(grep -c '^theorem' "$1.lean")"
  else printf '%-45s FAILED\n' "$1"; fail=1; fi
}
lean AttestSound
while read -r cfg exp; do
  [ -z "$cfg" ] && continue
  case "$cfg" in \#*) continue;; esac
  mod=${cfg%%_*}; case $mod in RS) mod=RolloutSkew;; SP) mod=SharedPool;; esac
  tlc "$mod" "$cfg" "$exp"
done <<'LIST'
RS_Witness_Raised violation
RS_AllNew_AsIs violation
RS_AllNew_Fixed pass
RS_AllNew_Fixed_Terminal pass
RS_Skew_Fixed_NoGate violation
RS_Skew_Fixed_NoGate_Consistent violation
RS_Skew_Fixed_Flag pass
RS_Skew_Fixed_Flag_Rollback pass
RS_Skew_Fixed_Flag_RollbackNoSettle violation
RS_Rollback_Fixed_Flag_Consistent pass
RS_Skew_Fixed_Flag_Terminal violation
SP_Rolling_Same_Fast pass
SP_Rolling_Same_Slow violation
SP_Rollback_Same violation
SP_Rollback_Same_Final pass
SP_Rollback_Cross_Pre4327 violation
SP_Rollback_Cross_4327 violation
SP_Rollback_Cross_4327_LowStamp pass
SP_PkgSkew_KillSwitch violation
SP_PkgSkew_NoKillSwitch pass
SP_PkgSkew_KillSwitch_Cross4327 violation
SP_KillSwitchNew_Rolling pass
SP_Rollback_Cross_Head_NoCache pass
SP_Rollback_Cross_Head_Cache violation
LIST
exit $fail
