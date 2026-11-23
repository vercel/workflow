#!/usr/bin/env bash
# Model-checks StreamPurge.tla with TLC for every *.cfg here.
# Needs Java 11+; downloads tla2tools.jar (TLA+ 1.8.0) into the cache once.
set -euo pipefail
cd "$(dirname "$0")"
JAR="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/tla2tools-1.8.0.jar}"
if [[ ! -f "$JAR" ]]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
fi
status=0
for cfg in ${@:-*.cfg}; do
  name="${cfg%.cfg}"
  out=$(java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -noGenerateSpecTE \
    -metadir "${TMPDIR:-/tmp}/tlc-$name" -config "$cfg" StreamPurge.tla 2>&1 || true)
  states=$(grep -oE '[0-9,]+ distinct states found' <<<"$out" | tail -1)
  if grep -q 'No error has been found' <<<"$out"; then result=holds
  elif grep -q 'is violated' <<<"$out"; then result=violated
  else result=error; echo "$out" >&2; fi
  # Main and Var_* are expected to be violated.
  case "$name:$result" in
    Main:violated|Var_*:violated) ok=expected ;;
    Main:*|Var_*:*) ok=UNEXPECTED; status=1 ;;
    *:holds) ok=expected ;;
    *) ok=UNEXPECTED; status=1 ;;
  esac
  printf '%-24s %-9s %-10s %s\n' "$name" "$result" "$ok" "${states:-}"
done
exit $status
