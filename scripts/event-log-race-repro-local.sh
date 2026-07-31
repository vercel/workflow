#!/usr/bin/env bash
#
# Run the event-log race repro harness locally, against @workflow/world-postgres
# and a workbench app started on this machine. No Vercel deployment, no GitHub
# Actions, no VERCEL_* credentials.
#
# This is the same harness `.github/workflows/event-log-race-repro.yml` runs
# (`packages/core/e2e/event-log-race-repro.test.ts`), pointed at a local backend.
# It exists because the ordering here is easy to get wrong in ways that fail
# silently rather than loudly:
#
#   * WORKFLOW_PUBLIC_MANIFEST=1 must be set at *build* time — the Next.js builder
#     emits the manifest as a static file during the build, and without it the
#     harness cannot resolve workflow IDs.
#   * WORKFLOW_TARGET_WORLD must be set at *build* time too. `withWorkflow()`
#     defaults it to `local` when VERCEL_DEPLOYMENT_ID is absent, which bakes the
#     filesystem backend into the app and leaves the harness talking to a
#     different world than the app is.
#   * The schema has to exist before the app boots, or Graphile Worker starts
#     against an unmigrated database.
#   * The queue has to be empty before the app boots. Postgres outlives the app
#     here, so an interrupted run leaves its unfinished flow messages behind and
#     the next boot resumes all of them — thousands of stale jobs starving the
#     run you actually care about. See clear_queue below.
#
# Usage: scripts/event-log-race-repro-local.sh [options]
# Run with --help for options.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_NAME="nextjs-turbopack"
PORT="3000"
USE_DEV="0"
SKIP_BUILD="0"
SKIP_DB_SETUP="0"
USE_DOCKER="1"
TEARDOWN="0"
KEEP_QUEUE="0"
# In CI every replay of a run lands in its own Fluid invocation; here they all
# land in one Next.js process, and a storm run has tens of replays in flight at
# once, each holding a VM sandbox and its own copy of the event log. That is
# enough to exceed Node's default old-space limit (~4 GB) and take the server
# down mid-run with an OOM, which then shows up as unrelated `stuck` outcomes.
SERVER_HEAP_MB="8192"

COMPOSE_FILE="packages/world-postgres/docker-compose.yaml"
# Matches the compose file and the `e2e-local-postgres` job in tests.yml.
DEFAULT_POSTGRES_URL="postgres://world:world@localhost:5432/world"
RESULTS_FILE="event-log-race-repro-results.json"
SERVER_LOG="event-log-race-repro-server.log"
RENDERER=".github/scripts/render-event-log-race-repro-results.js"

usage() {
  cat <<'EOF'
Run the event-log race repro harness against world-postgres + a local workbench app.

Options:
  --app NAME         Workbench app to drive (default: nextjs-turbopack).
                     The repro workflow fixtures (101_hook_sleep_repro.ts,
                     103_event_log_corruption_repro.ts) only exist in
                     workbench/nextjs-turbopack; another app needs them copied
                     or symlinked in first.
  --port N           Port for the app (default: 3000).
  --heap-mb N        Old-space limit for the app process (default: 8192). The
                     server holds every concurrent replay of every run, so the
                     default heap is not enough; lower this only if the machine
                     cannot spare it, and expect OOM-induced `stuck` outcomes.
  --dev              Use `pnpm dev` instead of a production build + `pnpm start`.
                     Faster to iterate on workflow fixtures; less like CI.
  --skip-build       Skip `pnpm build` and the app build. Use when only the
                     harness or the driver changed.
  --skip-db-setup    Skip applying migrations (schema already set up).
  --no-docker        Do not manage Postgres. Point WORKFLOW_POSTGRES_URL at your
                     own instance; the schema still needs to exist.
  --keep-queue       Leave queued Graphile Worker jobs in place. By default they
                     are deleted before the app boots: an interrupted earlier run
                     leaves its flow messages queued, and resuming those abandoned
                     runs saturates the app so this run reports `stuck` for
                     reasons that have nothing to do with the event log. Only
                     useful if you are inspecting the leftovers themselves.
  --teardown         Stop and delete the Postgres container on exit. Off by
                     default so repeat runs skip container startup.
  -h, --help         Show this help.

Scale knobs are read from the environment by the harness itself, so anything
already exported is passed through untouched:

  EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS   EVENT_LOG_RACE_REPRO_ROUNDS
  EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS   EVENT_LOG_RACE_REPRO_WIDTH
  EVENT_LOG_RACE_REPRO_ATTEMPTS              EVENT_LOG_RACE_REPRO_WATCHDOG_MS
  EVENT_LOG_RACE_REPRO_CONCURRENCY           EVENT_LOG_RACE_REPRO_STEP_DELAY_MS
  EVENT_LOG_RACE_REPRO_BUDGET_MS             EVENT_LOG_RACE_REPRO_POKE_INTERVAL_MS
  EVENT_LOG_RACE_REPRO_RUN_TIMEOUT_MS        EVENT_LOG_RACE_REPRO_HOOK_RESUME_STAGGER_MS

This script deliberately sets none of them. Their defaults — and the full list —
live in packages/core/e2e/event-log-race-repro.test.ts, which is the single
source of truth the CI workflow also defers to.

WORKFLOW_POSTGRES_WORKER_CONCURRENCY (default 50) caps how many replays the app
and the harness each run at once. Lowering it lowers the pressure the storms
apply, so prefer --heap-mb for memory problems and treat this as a last resort.

Examples:
  # Default scale (a regression check, a few minutes).
  scripts/event-log-race-repro-local.sh

  # One run per scenario, to smoke the plumbing.
  EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS=1 \
  EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS=1 \
  EVENT_LOG_RACE_REPRO_ATTEMPTS=1 \
    scripts/event-log-race-repro-local.sh

  # Soak for a rate, reusing an already-built app and database.
  EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS=600 \
  EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS=600 \
  EVENT_LOG_RACE_REPRO_ATTEMPTS=200 \
  EVENT_LOG_RACE_REPRO_CONCURRENCY=40 \
  EVENT_LOG_RACE_REPRO_BUDGET_MS=4500000 \
    scripts/event-log-race-repro-local.sh --skip-build --skip-db-setup
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_NAME="${2:?--app needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --heap-mb) SERVER_HEAP_MB="${2:?--heap-mb needs a value}"; shift 2 ;;
    --dev) USE_DEV="1"; shift ;;
    --skip-build) SKIP_BUILD="1"; shift ;;
    --skip-db-setup) SKIP_DB_SETUP="1"; shift ;;
    --no-docker) USE_DOCKER="0"; shift ;;
    --keep-queue) KEEP_QUEUE="1"; shift ;;
    --teardown) TEARDOWN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1m[repro]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[repro]\033[0m %s\n' "$*" >&2; exit 1; }

APP_DIR="workbench/$APP_NAME"
[ -d "$APP_DIR" ] || die "No such workbench app: $APP_DIR"

# The harness resolves these two workflow files through the deployment's
# manifest, so an app without them fails one attempt at a time with opaque
# harness errors instead of up front.
for fixture in 101_hook_sleep_repro.ts 103_event_log_corruption_repro.ts; do
  [ -e "$APP_DIR/workflows/$fixture" ] ||
    die "$APP_DIR/workflows/$fixture is missing — the repro fixtures live in workbench/nextjs-turbopack."
done

export WORKFLOW_POSTGRES_URL="${WORKFLOW_POSTGRES_URL:-$DEFAULT_POSTGRES_URL}"
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
export WORKFLOW_PUBLIC_MANIFEST="1"
export PORT="$PORT"
DEPLOYMENT_URL="http://localhost:$PORT"
MANIFEST_URL="$DEPLOYMENT_URL/.well-known/workflow/v1/manifest.json"

# --- port ---------------------------------------------------------------------

port_pids() { lsof -ti "tcp:$PORT" 2>/dev/null || true; }

if [ -n "$(port_pids)" ]; then
  die "Port $PORT is already in use (pids: $(port_pids | tr '\n' ' ')). Stop it or pass --port."
fi

# --- cleanup ------------------------------------------------------------------

SERVER_PID=""

cleanup() {
  local status=$?
  set +e
  if [ -n "$SERVER_PID" ]; then
    log "Stopping the app (pid $SERVER_PID)"
    # `pnpm start` is a wrapper around `next start`, so the pnpm pid is not the
    # listener. Kill the wrapper, then its children, then anything still holding
    # the port — a process-group kill is not portable here (macOS has no setsid).
    pkill -P "$SERVER_PID" >/dev/null 2>&1
    kill "$SERVER_PID" >/dev/null 2>&1
    local pids
    pids="$(port_pids)"
    [ -n "$pids" ] && echo "$pids" | xargs kill >/dev/null 2>&1
  fi
  if [ "$TEARDOWN" = "1" ] && [ "$USE_DOCKER" = "1" ]; then
    log "Removing the Postgres container"
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1
  fi
  set -e
  return $status
}
trap cleanup EXIT

# --- postgres -----------------------------------------------------------------

if [ "$USE_DOCKER" = "1" ]; then
  command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker, or use --no-docker with your own Postgres."
  log "Starting Postgres ($COMPOSE_FILE)"
  docker compose -f "$COMPOSE_FILE" up -d

  log "Waiting for Postgres to accept connections"
  for _ in $(seq 1 60); do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U world -d world >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U world -d world >/dev/null 2>&1 ||
    die "Postgres did not become ready. Check: docker compose -f $COMPOSE_FILE logs postgres"
else
  log "Using the Postgres at WORKFLOW_POSTGRES_URL (not managed by this script)"
fi

# --- queue ---------------------------------------------------------------------

# Runs a single statement as the `world` user. Prefers the container's own psql so
# no local Postgres client is required.
pg_exec() {
  if [ "$USE_DOCKER" = "1" ]; then
    docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U world -d world -At -c "$1" 2>/dev/null
  else
    psql "$WORKFLOW_POSTGRES_URL" -At -c "$1" 2>/dev/null
  fi
}

# The jobs table is private to graphile-worker and has been renamed across its
# versions, so resolve it instead of hardcoding one name, and no-op when the
# schema does not exist yet (a fresh database).
QUEUE_TABLE_SQL="select coalesce(to_regclass('graphile_worker._private_jobs')::text, to_regclass('graphile_worker.jobs')::text, '')"

clear_queue() {
  local table count
  table="$(pg_exec "$QUEUE_TABLE_SQL" || true)"
  [ -n "$table" ] || return 0
  count="$(pg_exec "select count(*) from $table" || echo "0")"
  [ "${count:-0}" -gt 0 ] || return 0
  pg_exec "delete from $table" >/dev/null ||
    die "Could not clear $table. Pass --keep-queue to skip this, or reset the database."
  # Loud on purpose: a backlog here means the previous run was interrupted, which
  # is worth knowing when comparing results between runs.
  log "Discarded $count queued job(s) left over from an earlier run ($table)"
}

if [ "$KEEP_QUEUE" = "0" ]; then
  if [ "$USE_DOCKER" = "0" ] && ! command -v psql >/dev/null 2>&1; then
    log "psql not found — leaving the queue as it is. Stale jobs from an interrupted run will compete with this one."
  else
    clear_queue
  fi
fi

# --- build --------------------------------------------------------------------

if [ "$SKIP_BUILD" = "0" ]; then
  # Turbo-cached, so this is cheap on repeat runs. Needed before the migration
  # step, which loads packages/world-postgres/dist/cli.js.
  log "Building packages"
  pnpm build
fi

if [ "$SKIP_DB_SETUP" = "0" ]; then
  log "Applying the world-postgres schema"
  ./packages/world-postgres/bin/setup.js
fi

if [ "$SKIP_BUILD" = "0" ] && [ "$USE_DEV" = "0" ]; then
  # WORKFLOW_PUBLIC_MANIFEST and WORKFLOW_TARGET_WORLD are exported above, so
  # they apply to this build as well as to the server started below. Both are
  # build-time inputs — see the header comment.
  log "Building $APP_NAME"
  pnpm --filter "$APP_NAME" build
fi

# --- server -------------------------------------------------------------------

if [ "$USE_DEV" = "1" ]; then
  SERVER_CMD="dev"
else
  SERVER_CMD="start"
fi

log "Starting $APP_NAME ($SERVER_CMD) on $DEPLOYMENT_URL — logging to $SERVER_LOG"
: > "$SERVER_LOG"
(
  cd "$APP_DIR" &&
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$SERVER_HEAP_MB" \
      pnpm "$SERVER_CMD" >> "$REPO_ROOT/$SERVER_LOG" 2>&1
) &
SERVER_PID=$!

# A 200 on the manifest proves both that the server is up and that the public
# manifest the harness depends on was actually emitted — a build without
# WORKFLOW_PUBLIC_MANIFEST=1 serves the app fine and 404s here.
log "Waiting for the workflow manifest at $MANIFEST_URL"
ready="0"
for _ in $(seq 1 180); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -40 "$SERVER_LOG" >&2
    die "The app exited before serving the manifest. Full log: $SERVER_LOG"
  fi
  if curl -fsS -o /dev/null "$MANIFEST_URL" 2>/dev/null; then
    ready="1"
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || {
  tail -40 "$SERVER_LOG" >&2
  die "Timed out waiting for $MANIFEST_URL. Full log: $SERVER_LOG"
}

# --- harness ------------------------------------------------------------------

log "Running the repro harness"
rm -f "$RESULTS_FILE"
set +e
DEPLOYMENT_URL="$DEPLOYMENT_URL" \
APP_NAME="$APP_NAME" \
NODE_OPTIONS="--enable-source-maps" \
  pnpm run test:e2e:event-log-race-repro --reporter=default
harness_status=$?
set -e

# A server that died mid-run makes every remaining attempt time out, so the
# harness reports a wall of `stuck` runs with no hint of why. Say so plainly —
# an OOM or a crash here is a local-environment problem, not a repro.
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  log "The app is no longer running — it died during the harness. Last lines:"
  tail -20 "$SERVER_LOG" >&2
  SERVER_PID=""
  harness_status=1
fi

# --- summary ------------------------------------------------------------------

if [ -f "$RESULTS_FILE" ]; then
  log "Summary"
  # Same renderer the CI job uses for its sticky comment; with no --run-url it
  # just prints the tables.
  node "$RENDERER" "$RESULTS_FILE"
  log "Full results: $RESULTS_FILE / app log: $SERVER_LOG"
else
  log "No $RESULTS_FILE was written — the harness died before its first checkpoint."
fi

if [ "$USE_DOCKER" = "1" ] && [ "$TEARDOWN" = "0" ]; then
  log "Postgres is still running. Stop it with: docker compose -f $COMPOSE_FILE down -v"
fi

# The harness' own exit code is the gate: it fails on any non-`completed`,
# non-`infra` outcome, which is the same rule as the renderer's --check.
exit "$harness_status"
