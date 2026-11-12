#!/bin/sh
# Throwaway, for the Mixedbread preview branch only. Prints where Next put the
# search export, then syncs the Store without failing the build.
echo "--- search export output"
find .next -name 'export.*' -not -path '.next/cache/*' 2>/dev/null | head -20
ls -la .next/server/app/api/search 2>&1 | head -12
node -e "console.log(JSON.stringify(require('./.next/prerender-manifest.json').routes['/api/search/export']))"
echo "--- build env names"
env | cut -d= -f1 | grep -E '^(NEXT_|NOW_|VERCEL$|VERCEL_ENV$|TURBO)' | sort | tr '\n' ' '
echo
if [ -n "$MXBAI_API_KEY" ]; then
  geistdocs search sync --allow-non-production || echo "--- search sync failed, build continues"
fi
