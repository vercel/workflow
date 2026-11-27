#!/usr/bin/env bash
# Rebuild and re-check every Lean file of the ResolveLean model, in dependency
# order, saving each file's full output (proof errors, #eval tables, timing) to
# results/<Module>.txt. A module that fails to check stops the run.
#
#   LEAN=/path/to/lean ./run.sh        # override the Lean binary
#   TLA2TOOLS is accepted for symmetry with the TLA+ models but unused here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LEAN="${LEAN:-$(command -v lean || echo "$HOME/.elan/bin/lean")}"
TLA2TOOLS="${TLA2TOOLS:-$HOME/.local/opt/tla2tools.jar}"
: "$TLA2TOOLS"
cd "$HERE"
mkdir -p build/CrossDeploy results
export LEAN_PATH="$HERE/build${LEAN_PATH:+:$LEAN_PATH}"
"$LEAN" --version | tee results/lean-version.txt
status=0
for m in Spec Resolve Raise StaleSkip Combined; do
  echo "== CrossDeploy.$m ($(date -u +%H:%M:%S)) =="
  start=$(date +%s)
  set +e
  timeout "${LEAN_TIMEOUT:-2400}" "$LEAN" -R "$HERE" -o "build/CrossDeploy/$m.olean" "CrossDeploy/$m.lean" > "results/$m.txt" 2>&1
  rc=$?
  set -e
  end=$(date +%s)
  echo "exit=$rc elapsed=$((end - start))s" >> "results/$m.txt"
  if grep -qE '(^|: )error' "results/$m.txt" || [ $rc -ne 0 ]; then
    echo "   FAILED (exit $rc), see results/$m.txt"; status=1; break
  fi
  if grep -q "declaration uses 'sorry'" "results/$m.txt"; then
    echo "   contains sorry, see results/$m.txt"; status=1; break
  fi
  echo "   ok in $((end - start))s ($(grep -c "^theorem" "CrossDeploy/$m.lean") theorems checked)"
done
exit $status
