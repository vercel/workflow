#!/usr/bin/env bash
# Regenerates every artifact under idl/world/generated.
#
# Requires the Smithy CLI (https://smithy.io/2.0/guides/smithy-cli) on PATH and
# network access, since `smithy build` resolves the TypeScript code generator
# from Maven Central. Python 3.10+ is required for the port emitter.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v smithy >/dev/null 2>&1; then
  echo "smithy CLI not found on PATH" >&2
  exit 1
fi

echo "==> smithy build"
rm -rf build
smithy build

echo "==> typescript types (smithy-typescript, types mode)"
rm -rf generated/typescript
mkdir -p generated/typescript
cp -r build/smithy/source/typescript-codegen/src/* generated/typescript/

echo "==> typescript + python ports"
mkdir -p generated/python/workflow_world
python3 scripts/generate_ports.py \
  build/smithy/source/model/model.json \
  generated/typescript \
  generated/python/workflow_world

echo "==> done"
