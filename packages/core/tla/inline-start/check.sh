#!/usr/bin/env bash
# Model-checks InlineStart.tla with TLC for every *.cfg here (or the ones
# named). Uses local Java 11+ when present, else Docker (eclipse-temurin).
# Downloads tla2tools.jar (TLA+ 1.8.0) into the cache once.
set -euo pipefail
cd "$(dirname "$0")"
JAR="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/tla2tools-1.8.0.jar}"
if [[ ! -f "$JAR" ]]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar
fi
tlc() {
  local cfg=$1 meta="/tmp/tlc-inline-start-${1%.cfg}"
  local args=(-XX:+UseParallelGC -cp /jar/tla2tools.jar tlc2.TLC -workers auto
    -deadlock -noGenerateSpecTE -metadir "$meta" -config "$cfg" InlineStart.tla)
  if command -v java >/dev/null; then
    java "${args[@]/\/jar\/tla2tools.jar/$JAR}"
  else
    docker run --rm -v "$PWD:/spec" -v "$JAR:/jar/tla2tools.jar:ro" -w /spec \
      eclipse-temurin:21-jre java "${args[@]}"
  fi
}
status=0
for cfg in ${@:-*.cfg}; do
  name="${cfg%.cfg}"
  out=$(tlc "$cfg" 2>&1 || true)
  states=$(grep -oE '[0-9,]+ distinct states found' <<<"$out" | tail -1)
  if grep -q 'No error has been found' <<<"$out"; then result=holds
  elif grep -qE 'is violated|was violated' <<<"$out"; then result=violated
  else result=error; echo "$out" >&2; fi
  # Bug_* (seeded bugs) and Probe_Orphan_* (a pre-existing window) are
  # expected to be violated.
  case "$name:$result" in
    Bug_*:violated|Probe_Orphan_*:violated) ok=expected ;;
    Bug_*:*|Probe_Orphan_*:*) ok=UNEXPECTED; status=1 ;;
    *:holds) ok=expected ;;
    *) ok=UNEXPECTED; status=1 ;;
  esac
  printf '%-32s %-9s %-10s %s\n' "$name" "$result" "$ok" "${states:-}"
done
exit $status
