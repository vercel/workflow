#!/usr/bin/env bash
# install-e2e — install every installable pattern into the fixture app via
# the real shadcn CLI, against the registry served at $1 (defaults to the
# local docs dev server). Used by patterns-checks.yml and the nightly run
# (which passes https://workflow-sdk.dev and an unpinned CLI).
set -euo pipefail

REGISTRY_BASE="${1:-http://localhost:3000}"
# Pin for PR determinism; the nightly passes SHADCN_VERSION=latest.
SHADCN_VERSION="${SHADCN_VERSION:-3.4.0}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE="$ROOT/workbench/install-fixture"

# Enumerate installable pattern ids from the manifest.
IDS=$(cd "$ROOT/docs" && bun -e "
const { registryItems } = await import('./lib/patterns/manifest.ts');
console.log(registryItems.filter((i) => i.installable !== false).map((i) => i.id).join('\n'));
")

# Start from a clean slate so we prove the CLI delivers everything.
rm -rf "$FIXTURE/app/workflows" "$FIXTURE/lib"
mkdir -p "$FIXTURE/app/workflows"
touch "$FIXTURE/app/workflows/.gitkeep"

cd "$FIXTURE"
FAILED=()
for id in $IDS; do
  echo "── installing $id"
  if ! pnpm dlx "shadcn@$SHADCN_VERSION" add --yes --overwrite "$REGISTRY_BASE/r/$id" >/tmp/shadcn-$id.log 2>&1; then
    echo "::error::shadcn add failed for $id"
    tail -20 "/tmp/shadcn-$id.log"
    FAILED+=("$id")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "::error::${#FAILED[@]} pattern(s) failed to install: ${FAILED[*]}"
  exit 1
fi

INSTALLED=$(find app/workflows lib -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
echo "Installed $INSTALLED files from $(echo "$IDS" | wc -l | tr -d ' ') patterns."

if [ "$INSTALLED" -lt 20 ]; then
  echo "::error::Suspiciously few files installed ($INSTALLED) — expected 30+."
  exit 1
fi
