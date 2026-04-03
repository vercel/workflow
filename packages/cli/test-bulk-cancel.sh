#!/bin/bash
# E2E tests for bulk cancel + --status filter + step JSON hydration
# Prerequisites: pnpm build (in packages/cli), workbench running on :3000
# Usage: bash test-bulk-cancel.sh [--record]
#
# NOTE on starting workflows:
# - addTenWorkflow: started via HTTP API (completes fast, headers arrive immediately)
# - sleepingWorkflow: started via CLI `workflow start <runId>` in background
#   (HTTP API blocks until workflow completes since headers wait for first stream chunk)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKBENCH_DIR="$REPO_ROOT/workbench/nextjs-turbopack"
CLI_BIN="$SCRIPT_DIR/bin/run.js"

cli() { (cd "$WORKBENCH_DIR" && WORKFLOW_NO_UPDATE_CHECK=1 node "$CLI_BIN" "$@"); }

WORKBENCH="http://localhost:3000"
BK="--backend local"
PASS=0; FAIL=0; TOTAL=0

# Record mode
LOGFILE=""
if [[ "${1:-}" == "--record" ]]; then
  LOGFILE="$SCRIPT_DIR/test-results-$(date +%Y%m%d-%H%M%S).log"
  echo "Recording to $LOGFILE"
fi
log() {
  if [[ -n "$LOGFILE" ]]; then echo "$@" | tee -a "$LOGFILE"; else echo "$@"; fi
}
run_test() {
  TOTAL=$((TOTAL + 1))
  log ""; log "══════════════════════════════════════════"
  log "TEST $TOTAL: $1"; log "══════════════════════════════════════════"
}
pass() { PASS=$((PASS + 1)); log "PASS ✅"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL ❌: $1"; }

# Start addTenWorkflow via HTTP (fast — completes in <1s, headers arrive immediately)
start_fast() {
  local arg="$1"
  node -e '
    const http = require("http");
    const body = JSON.stringify({workflowName: "addTenWorkflow", args: ['"$arg"']});
    const req = http.request({
      hostname: "localhost", port: 3000, path: "/api/workflows/start", method: "POST",
      headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)}
    }, (res) => { process.stdout.write(res.headers["x-workflow-run-id"] || ""); res.destroy(); process.exit(0); });
    req.on("error", () => process.exit(1));
    req.end(body);
    setTimeout(() => process.exit(1), 30000);
  ' 2>/dev/null
}

# Start sleepingWorkflow via HTTP API (fire-and-forget, get run ID from inspect)
# The HTTP API blocks until first stream chunk (= workflow completion for sleeping),
# so we fire the request in background and discover the run ID via inspect.
SEED_RUN_ID=""  # unused now but kept for reference
start_sleeping() {
  local duration="${1:-30000}"
  # Fire HTTP request in background (don't wait for response)
  node -e '
    const http = require("http");
    const body = JSON.stringify({workflowName: "sleepingWorkflow", args: ['"$duration"']});
    const req = http.request({
      hostname: "localhost", port: 3000, path: "/api/workflows/start", method: "POST",
      headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)}
    }, () => {});
    req.on("error", () => {});
    req.end(body);
    // Keep process alive briefly so server receives the request
    setTimeout(() => process.exit(0), 2000);
  ' 2>/dev/null &
  local node_pid=$!
  # Wait for the run to appear in the local world
  sleep 3
  # Get the most recent running sleepingWorkflow run
  local run_id=$(cli inspect runs --status=running --json $BK --limit 10 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d['data']:
    if 'sleepingWorkflow' in r.get('workflowName', ''):
        print(r['runId'])
        break
" 2>/dev/null)
  wait $node_pid 2>/dev/null || true
  if [[ -z "$run_id" ]]; then
    log "ERROR: No running sleepingWorkflow found after start"
    return 1
  fi
  echo "$run_id"
}

# ── Preflight ──
log "Checking workbench at $WORKBENCH..."
if ! curl -s -o /dev/null -w "%{http_code}" "$WORKBENCH" 2>/dev/null | grep -q "200\|302"; then
  log "ERROR: Workbench not running. Start with: cd workbench/nextjs-turbopack && pnpm dev"
  exit 1
fi
log "Workbench is up."

# Warmup — first API call triggers route compilation
log "Warming up API routes..."
start_fast 1 > /dev/null || { log "ERROR: Warmup failed"; exit 1; }
log "Warmup done."
sleep 2

# Cleanup
log "Cleaning up leftover runs..."
cli cancel --status=running -y $BK 2>&1 || true
sleep 1

# ── Test 1: Single cancel regression ──
run_test "Single cancel (regression)"
RUN_ID=$(start_sleeping 30000)
log "Started: $RUN_ID"
sleep 2
cli cancel "$RUN_ID" $BK 2>&1
sleep 1
STATUS=$(cli inspect run "$RUN_ID" --json $BK 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
log "Status after cancel: $STATUS"
[[ "$STATUS" == "cancelled" ]] && pass || fail "expected cancelled, got $STATUS"

# ── Test 2: --status filter on inspect runs ──
run_test "--status filter on inspect runs"
RUN_ID=$(start_fast 100)
log "Started: $RUN_ID"
sleep 3
COMPLETED=$(cli inspect runs --status=completed --json $BK 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))")
log "Completed runs found: $COMPLETED"
[[ "$COMPLETED" -gt 0 ]] && pass || fail "no completed runs found"

# ── Test 3: Bulk cancel --status=running ──
run_test "Bulk cancel --status=running"
# Fire 3 sleepingWorkflow requests in parallel
for i in 1 2 3; do
  node -e '
    const http = require("http");
    const body = JSON.stringify({workflowName: "sleepingWorkflow", args: [30000]});
    const req = http.request({hostname: "localhost", port: 3000, path: "/api/workflows/start", method: "POST",
      headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)}}, () => {});
    req.on("error", () => {}); req.end(body);
    setTimeout(() => process.exit(0), 2000);
  ' 2>/dev/null &
done
sleep 4
RUNNING_BEFORE=$(cli inspect runs --status=running --json $BK 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))")
log "Running before cancel: $RUNNING_BEFORE"
log "--- Cancelling all running ---"
cli cancel --status=running -y $BK 2>&1
sleep 1
RUNNING=$(cli inspect runs --status=running --json $BK 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))")
log "Remaining running: $RUNNING"
[[ "$RUNNING" -eq 0 ]] && pass || fail "$RUNNING runs still running"

# ── Test 4: Bulk cancel --workflowName filter ──
# NOTE: workflowName must be the full WDK path (e.g. workflow//./workflows/99_e2e//sleepingWorkflow)
# Short names like "sleepingWorkflow" won't match. This is expected — the World API does exact match.
# On Vercel backend, names look different (deployment-based). This test uses the local backend path.
run_test "Bulk cancel --workflowName filter"
# Start 2 sleepingWorkflows
for i in 1 2; do
  node -e '
    const http = require("http");
    const body = JSON.stringify({workflowName: "sleepingWorkflow", args: [30000]});
    const req = http.request({hostname: "localhost", port: 3000, path: "/api/workflows/start", method: "POST",
      headers: {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)}}, () => {});
    req.on("error", () => {}); req.end(body);
    setTimeout(() => process.exit(0), 2000);
  ' 2>/dev/null &
done
sleep 4
# Get the full workflowName from a running run
FULL_WF_NAME=$(cli inspect runs --status=running --json $BK --limit 1 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['workflowName'] if d['data'] else '')" 2>/dev/null)
RUNNING_BEFORE=$(cli inspect runs --status=running --json $BK 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))")
log "Running before cancel: $RUNNING_BEFORE (name: $FULL_WF_NAME)"
log "--- Cancelling by workflowName ---"
cli cancel --workflowName="$FULL_WF_NAME" --status=running -y $BK 2>&1
sleep 1
RUNNING_AFTER=$(cli inspect runs --status=running --json $BK 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))")
log "Running after cancel: $RUNNING_AFTER"
[[ "$RUNNING_AFTER" -eq 0 ]] && pass || fail "$RUNNING_AFTER runs still running"

# ── Test 5: No matching runs ──
run_test "No matching runs warning"
cli cancel --status=running -y $BK 2>&1 || true
sleep 1
OUTPUT=$(cli cancel --status=running -y $BK 2>&1 || true)
log "$OUTPUT"
echo "$OUTPUT" | grep -qi "no matching" && pass || fail "expected 'no matching' warning"

# ── Test 6: Step JSON hydration ──
run_test "Step JSON hydration fix"
RUN_ID=$(start_fast 100)
log "Started: $RUN_ID"
sleep 4
STEP_IO=$(cli inspect steps --runId="$RUN_ID" --withData --json $BK 2>/dev/null)
log "Checking step IO hydration..."
if echo "$STEP_IO" | python3 -c "
import sys, json
data = json.load(sys.stdin)
found = False
for step in data:
    out = step.get('output')
    if out is not None:
        found = True
        if isinstance(out, dict) and '0' in out:
            print(f'RAW_BYTES: {out}')
            sys.exit(1)
        print(f'HYDRATED: {out}')
if not found:
    print('NO_OUTPUT')
    sys.exit(1)
" 2>/dev/null; then
  pass
else
  fail "raw byte arrays or no output"
fi

# ── Test 7: hasMore warning ──
run_test "hasMore warning with --limit=1"
start_fast 200 > /dev/null || true
sleep 3
OUTPUT=$(cli cancel --status=completed --limit=1 -y $BK 2>&1 || true)
log "$OUTPUT"
echo "$OUTPUT" | grep -qi "more runs\|increase --limit\|More runs match" && pass || fail "no hasMore warning"

# ── Test 8: Error on no args/flags ──
run_test "Error when no runId or filters"
OUTPUT=$(cli cancel $BK 2>&1 || true)
log "$OUTPUT"
echo "$OUTPUT" | grep -qi "provide a run id\|--status\|--workflowName" && pass || fail "no usage error"

# ── Cleanup background start processes ──
pkill -f "workflow.*start.*--backend local" 2>/dev/null || true

# ── Summary ──
log ""; log "══════════════════════════════════════════"
log "RESULTS: $PASS passed, $FAIL failed, $TOTAL total"
log "══════════════════════════════════════════"
[[ -n "$LOGFILE" ]] && log "Output saved to: $LOGFILE"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
