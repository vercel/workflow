#!/bin/bash
# Storm runner: reproduces the event-log-race-repro CI job locally against
# the local or postgres world.
#
# Usage: ./run-storm.sh <label> <repo_dir> <world: local|postgres> [step_attempts] [hook_attempts]
set -uo pipefail

LABEL="$1"
REPO_DIR="$2"
WORLD="$3"
STEP_ATTEMPTS="${4:-48}"
HOOK_ATTEMPTS="${5:-48}"

WB="$REPO_DIR/workbench/nextjs-turbopack"
PORT=3000
RESULTS_DIR="/tmp/storm-results"
mkdir -p "$RESULTS_DIR"

echo "=== Storm: $LABEL (world=$WORLD, step=$STEP_ATTEMPTS, hook=$HOOK_ATTEMPTS) ==="

# 1. Clean state
rm -rf "$WB/.next/workflow-data"
SERVER_ENV=(WORKFLOW_PUBLIC_MANIFEST=1 PORT=$PORT)
TEST_ENV=()
if [ "$WORLD" = "postgres" ]; then
  DB="storm_$(echo "$LABEL" | tr -c 'a-z0-9' '_')"
  docker exec workflow-postgres psql -U world -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null
  docker exec workflow-postgres psql -U world -d postgres -c "CREATE DATABASE $DB" >/dev/null
  PG_URL="postgres://world:world@localhost:5432/$DB"
  (cd "$REPO_DIR" && WORKFLOW_POSTGRES_URL="$PG_URL" ./packages/world-postgres/bin/setup.js) >/dev/null 2>&1
  SERVER_ENV+=(WORKFLOW_TARGET_WORLD=@workflow/world-postgres WORKFLOW_POSTGRES_URL="$PG_URL")
  TEST_ENV+=(WORKFLOW_TARGET_WORLD=@workflow/world-postgres WORKFLOW_POSTGRES_URL="$PG_URL")
fi

# 2. Start the production server. 12 concurrent storm runs of full VM
# replays legitimately need more than node's default ~4GB heap.
SERVER_LOG="/tmp/storm-server-$LABEL.log"
(cd "$WB" && env "${SERVER_ENV[@]}" NODE_OPTIONS="--max-old-space-size=12288" pnpm start > "$SERVER_LOG" 2>&1) &
SERVER_PID=$!
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/" -o /dev/null; then break; fi
  sleep 1
done
if ! curl -sf "http://localhost:$PORT/" -o /dev/null; then
  echo "SERVER FAILED TO START"; tail -20 "$SERVER_LOG"; kill $SERVER_PID 2>/dev/null; exit 1
fi
echo "server up (pid $SERVER_PID)"

# 3. Run the storm
rm -f "$REPO_DIR/event-log-race-repro-results.json"
(cd "$REPO_DIR" && env \
  NODE_OPTIONS="--enable-source-maps" \
  DEPLOYMENT_URL="http://localhost:$PORT" \
  APP_NAME="nextjs-turbopack" \
  ${TEST_ENV[@]+"${TEST_ENV[@]}"} \
  EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS="$STEP_ATTEMPTS" \
  EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS="$HOOK_ATTEMPTS" \
  EVENT_LOG_RACE_REPRO_ATTEMPTS=0 \
  EVENT_LOG_RACE_REPRO_CONCURRENCY=8 \
  EVENT_LOG_RACE_REPRO_BUDGET_MS=2700000 \
  pnpm vitest run packages/core/e2e/event-log-race-repro.test.ts --reporter=default \
  > "/tmp/storm-test-$LABEL.log" 2>&1)
STATUS=$?

# 4. Collect results
if [ -f "$REPO_DIR/event-log-race-repro-results.json" ]; then
  mv "$REPO_DIR/event-log-race-repro-results.json" "$RESULTS_DIR/$LABEL.json"
  echo "results saved to $RESULTS_DIR/$LABEL.json"
else
  echo "NO RESULTS FILE (test exit $STATUS)"; tail -30 "/tmp/storm-test-$LABEL.log"
fi

# 5. Stop the server (pnpm start spawns next-server children)
kill $SERVER_PID 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2
pkill -9 -f "next-server" 2>/dev/null

# 6. Summarize
if [ -f "$RESULTS_DIR/$LABEL.json" ]; then
  node -e '
    const r = require(process.argv[1]);
    console.log("partial:", r.partial, "planned:", r.plannedAttempts);
    console.log(JSON.stringify(r.scenarioDistribution, null, 2));
  ' "$RESULTS_DIR/$LABEL.json"
fi
echo "=== done: $LABEL (exit $STATUS) ==="
