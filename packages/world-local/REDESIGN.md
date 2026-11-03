# world-local redesign: one SQLite file, one transaction per write

Status: proposal, for discussion. Nothing in this document is implemented yet.

This document covers three things:

- why world-local keeps producing crash and race bugs;
- which architectures remove those bugs by construction rather than one by one;
- a recommended design and how to migrate to it.

It was written after reading the package changelog, the git history of
`packages/world-local/src` since July 2026, and the open world-local issues
and PRs.

Out of scope: slimming down world-local's configuration options and docs.
That work is tracked separately. The end of section 6 only lists the knobs this design
makes unnecessary.

---

## 1. Summary

- **Most world-local bugs share two causes.** The first is a single logical
  write spread over several files with no transaction around them. The
  second is hand-rolled lock files that have to guess whether their holder is
  still alive. Together they account for well over half of the last ~45
  fixes and open issues (section 2). Every one of those fixes adds a repair
  path for one crash window. Each repair path then has crash windows of its
  own.
- **The queue lives only in memory.** Every restart loses delayed messages,
  wait timers and retry backoffs. Recovery then re-invokes every non-terminal
  run and guesses at which steps were in flight. A second process on the same
  data dir, such as a script or a vitest run calling `start()`, has no shared
  state with the first except those lock files.
- **Recommendation: SQLite.** Keep one database file, `<dataDir>/world.db`,
  opened with the runtime's built-in driver (`node:sqlite` on Node,
  `bun:sqlite` on Bun) in WAL mode. Each `events.create` becomes one
  `BEGIN IMMEDIATE` transaction. That transaction checks the fence, validates
  the state transition, assigns the event's position, appends the event and
  updates the materialized rows. All of it commits, or none of it does.
- **Materialized rows can stay.** They were never the problem. Writing them
  non-atomically was. Inside a transaction they cost almost nothing, and
  spec 8 runs still need them. Once spec 8 is retired, the step and wait
  tables can be dropped without touching anything else.
- **Move the queue into the same file.** Messages get leases, delays and
  idempotency keys. A per-run orchestrator lane allows at most one leased
  orchestrator message per run across all processes, which is what
  world-postgres gets from Graphile named queues. Streams and snapshots move
  into the same file too.
- **The spikes back this up.** I ran them against `node:sqlite` on Node
  24.22.1 with SQLite 3.53.4 (section 7):
  - 8 processes writing concurrently sustained about 22,000 transactional
    event writes per second, with p99 under 3 ms.
  - 200 random `SIGKILL`s left no materialized row without its event, no gap
    in any run's sequence, and `integrity_check = ok`.
  - A 6-consumer queue with 15 consumers killed mid-run never let two
    deliveries of one run overlap.
- **What gets deleted.** The rewrite removes the fence-lock, token-claim,
  marker, staging-slot, hook-index and stream-placement machinery: about
  12.6k lines of source today. It also removes `proper-lockfile` and the
  Windows retry layer.

---

## 2. Changelog forensics: what the recent fixes were about

Sources:

- the `CHANGELOG.md` entries for 5.0.0 through 5.2.0;
- the unreleased changesets in `.changeset/`;
- `git log -- packages/world-local/src`;
- the open world-local issues and PRs as of 2026-11-03.

PR and issue numbers refer to `vercel/workflow`.

### Class A: one logical write split across several files, with crash windows between them

A step, wait, hook or run change is written today as:

1. a claim or marker file in `.locks/`;
2. then an entity JSON;
3. then the event file.

Some paths add a token claim, index entries, a by-run marker and a staging
file. A crash anywhere in that sequence leaves state that every later write
refuses, while replay, which reads only events, never sees the change.

| PR / issue | Symptom |
|---|---|
| #5219 (open), #4932, #5153 (open), issue #5083 | Crash between the `.created` or `.terminal` claim and the event leaves the run `running` forever, or the step "already created" forever. |
| #5189, `.changeset/world-local-interrupted-hook-created.md`, issue #5176 (open) | Interrupted `hook_created`: the token claim names a slot another hook has since taken, so the run spins to `MAX_DELIVERIES_EXCEEDED`. |
| #4922 / issue #4836 | Interrupted run creation leaves a run record with no `run_created` event. |
| #2747 | Lost hook cache files after a crash let an active token be reused. |
| #2295 | Crash-orphaned token claims, and duplicate `hook_created` treated as a self-conflict. |
| #3492 | `CORRUPTED_EVENT_LOG` from holes left by hook-resume staging slots. |
| #3297 | A redelivered `hook_received` rejected against its own half-committed resume claim, so the continuation was dropped. |
| #4636 | A retry publishing before the original token-claim owner produced a duplicate `hook_created`. |
| #2296 | Readers saw partially written entity files. |

### Class B: hand-rolled locks that must guess whether their holder is alive

The design rules here are: a lock is a file or directory, the owner is
written after the lock is created, a lock older than 30 s counts as stale,
and a holder is dead if `kill(pid, 0)` returns `ESRCH`.

| PR / issue | Symptom |
|---|---|
| #5000 / issue #4967 | A process killed while holding a run's fence lock stalled that run for 30 s. |
| issue #5161 (open) | A `SIGKILL` between `mkdir` and the owner write still stalls for 30 s. The fix is blocked by compatibility with older lock formats. |
| #5190, `.changeset/world-local-claim-lock-takeover.md` | The same 30 s stall for hook token claim locks. |
| #2808 | A stalled claim release deleted the next claimant's live claim. |
| #5162 | The fence-lock `SIGKILL` test was flaky on loaded runners. |
| #4742 | A tagged `clear()` deleted another tag's lock files and reopened its disposed hooks. |
| #5219 | Claims had to adopt the fence-lock owner format, because a worker thread's live claim was taken over and produced two `step_completed` events. |

### Class C: check-then-act races with no compare-and-swap across files

| PR / issue | Symptom |
|---|---|
| #1877 | Two concurrent `step_created` / `wait_created` for one correlation id both succeeded. |
| #2779 | A hook token could be reused after `dispose()`, both within a run and across runs. |
| #2808 | A `resumeHook` racing `dispose()` was recorded after the disposal and corrupted replay. |
| #2987 | `hook_received` was accepted on a run terminating concurrently in another process. |
| #4924 / issue #4923 | A resume racing a forced hook claim was lost. |
| #3457 | A redelivered `step_started` on a terminal run re-executed the step. |
| #4834 | In-band event-count conflicts when several processes wrote, and the count did not survive a restart. |
| #4754 | Stream names were dropped from `streams.list` when several streams first wrote at once. |
| #5025 (open) | Concurrent step publication contention. |

### Class D: per-process memory treated as shared state

| PR / issue | Symptom |
|---|---|
| #5145 | A `start()` or `resumeHook()` from another process (a script or test runner) overlapped the app's deliveries of the run. Its writes were then refused by the fence, because the spec 9 run gate is an in-memory promise chain. |
| #4834 | The in-band count was kept in memory. |
| #3728 | Module-scope state was duplicated across bundled copies. |
| (latent, from code reading) | Several caches can go stale against another process: `runSlotState` (stale `snapshot.seq`), `createdFilesCache` (reports "exists" after another process deleted the file), `eventCache` (can serve payloads a zero-retention purge scrubbed), and `withRunFileLock` (in-process only, so cross-process run writes can lose updates). |

### Class E: a volatile, in-memory queue

| PR / issue | Symptom |
|---|---|
| #4940 / issue #4939 | Restart waited out the 860 s inline-ownership lease before redispatching steps the dead process owned. |
| #4780 (open) | Redeliver a dead process's in-flight messages at `start()`. |
| #3255 | Stalled deliveries waited forever. |
| #2679 | Transport failures under load dropped messages, leaving steps that never started. |
| #4351 | A 30 s default delivery deadline re-executed long-running steps. |
| #4661 | A concurrency slot was held across sleeps. After 32 failed attempts the message now backs off. |
| #3824 | `close()` left deliveries running. |
| #2667, #2888 | Startup recovery re-enqueued another tag's or another namespace's runs. |
| issue #4728 | A retry was lost when a queued and an inline delivery of the same step raced. |

### Class F: stream ordering derived from file names

| PR / issue | Symptom |
|---|---|
| #4909, #5069 / issues #4878, #5026, #5071 | Chunks were delivered out of order or twice. |
| #5092 (open) | A `startIndex` past the tail was not honored. |
| issue #4830 (open), #2807 | Idle tail readers rescanned every chunk, or every chunk in the world. |
| #4754 | The stream index needed its own lock. |

### Class G: platform filesystem quirks

| PR / issue | Symptom |
|---|---|
| #3215, #4051, #4331 / issue #4203 (open) | Transient Windows `EPERM` on unlink, read and probe. |
| #4838 | Bun's `opendir` reports `ENOENT` on the first read, not when the directory is opened. |
| #1829 | Path traversal through request-supplied ids. |
| #3144 | Read-only filesystem. |
| `run-dir-guards` | Symlinked run directories. |

### Class H: reads that scan directories

| PR | Symptom |
|---|---|
| #2830 | Hook lookups scanned the global event log. Fixed by adding indexes, which brought new crash windows; see #5189. |
| #4718 | One directory per run, which wiped existing local data. |
| #2152, #2139 | Bounded caches added to cut replay I/O. |
| issue #4830 | Long streams rescanned on every idle poll. |

### What the classes have in common

- **Classes A, B and C** come from treating a directory of files as a
  database that has no transactions and no lock manager.
- **Class D** comes from patching that gap with per-process memory.
- **Class E** comes from not persisting the queue at all.
- **Classes F and H** come from deriving order and lookups from directory
  listings.
- **Class G** comes from heavy file churn: thousands of create, rename,
  link and unlink calls per run.

None of these is about materialization as such. A materialized row written
in the same atomic commit as its event cannot drift from it.

---

## 3. Options

### Option 0: keep hardening the filesystem design

We have done this for months. Each fix closes one window and opens new code
paths: repair, takeover, convergence, re-targeting. Each of those has crash
windows of its own. The current #5219 adds 30 s takeover rules, pid and
pid-namespace checks, and `TooEarlyError` redelivery to finish writes a
crash cut short. That is a lot of machinery for a dev backend. Rejected.

### Option 1: spec 9 log-only on files (`events/<runId>/<n>.json`)

Drop materializations, make `O_EXCL` creation of the next position file the
only compare-and-swap, and treat a run as existing if any of its events
exists.

This removes the claim-entity-event crash windows for steps and waits. It
does not remove the rest:

- **Spec 8 is still the default.** `mintedSpecVersion` returns 8 unless
  `WORKFLOW_SPEC_VERSION=9`, and the World must keep serving the spec 8 runs
  it already created. Those need step and wait state at write time.
- **Hook tokens are unique across runs.** That needs a cross-run
  compare-and-swap, which is a token file, so there are again two files per
  logical write: the token claim and `hook_created`. A forced claim
  additionally writes into the victim run's log. This is exactly where
  #5176, #5189 and #4924 live.
- **Validation becomes a scan.** Validating a transition means folding the
  run's log, which is O(n) per write and O(n²) per run. The alternative is a
  cache, and a cache is per-process state (class D).
- **The in-band fence still needs a counter** that is read and advanced
  atomically with the append. Deriving it from the log means a scan under a
  lock, or a counter file and a lock: class B again.
- **Listing is still a scan.** `runs.list` with filters and `hooks.list`
  still read the directory.
- **The queue and streams still need leases and ordering,** which on files
  means more lock files.
- **Windows and Bun quirks remain,** because the design is still file churn.

This option removes perhaps half of class A and does little for B through H.

### Option 2: SQLite with transactional materializations (recommended)

One database file. Every World write is one short transaction. SQLite takes
care of:

- **Atomicity across "files".** An event, the run, step, wait and hook rows,
  a token, a counter and a queue message all commit together or not at all.
  A `SIGKILL` at any instruction leaves the previous committed state: the
  WAL is rolled back on next open.
- **Locking that the OS cleans up.** SQLite's write lock is an `fcntl` lock
  on Unix and `LockFileEx` on Windows. The kernel releases it when the
  process dies. Nothing has to guess whether a holder is alive or wait for a
  lock to go stale, and no lock file is left behind.
- **Serializable writes.** `BEGIN IMMEDIATE` takes the write lock up front,
  so a read-validate-write sequence cannot interleave with another writer,
  in this process or any other.
- **Indexes.** Hook token lookups, `listByCorrelationId`, `runs.list`
  filters and stream tails become index seeks.
- **Synchronous execution.** `node:sqlite` and `bun:sqlite` run statements
  synchronously, so a transaction cannot be interleaved by an `await` in
  this process. The in-process step, hook, run and fence locks all go away.

Peter's concern from the thread is a fair one: *"single writer for SQLite is
different from single writer in workflow"*. Two orchestrator invocations can
still each try an optimistic insert. Three layers cover it:

1. **The in-band fence** is a column check inside the transaction. The loser
   gets `InBandSupersededError` and writes nothing. This is what
   world-postgres does with `SELECT … FOR UPDATE`.
2. **The orchestrator lane** in the queue (section 4.4) means two
   orchestrator deliveries of one run are not in flight at the same time,
   across every process on the data dir. That fixes the double-execution
   case at the source instead of refusing the second writer afterwards.
3. **Step idempotency keys** live in the queue table with the 24 h window
   spec 9 asks for. `step_started` keeps refusing a step that already has
   an outcome. Steps stay at-least-once across a crash, as on every World,
   but there is no double execution without one.

### Option 2b: SQLite with log-only storage (no materialized tables)

Possible: views or a fold over `events WHERE run_id = ?`. It is not
recommended now, for two reasons. Spec 8 still needs per-step state at write
time, which would mean folding the log on every write. And the materialized
rows are free once they are transactional. Once spec 8 is retired, dropping
`steps` and `waits` touches only the write path for those event types.

---

## 4. Proposed architecture

### 4.1 Storage file and driver

- **File:** `<dataDir>/world.db`, plus SQLite's `-wal` and `-shm` files.
  Nothing else lives in the data dir except `version.txt`. Large values stay
  inline as BLOBs.
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout=10000`, `foreign_keys=ON`. NORMAL loses at most the last
  transactions on power loss, never consistency. That is acceptable for
  local dev and matches today's no-fsync design.
- **Driver adapter:** about 50 lines exposing `exec`, `prepare`, `get`,
  `all`, `run` and `transaction(fn)`.
  - Node: `node:sqlite` `DatabaseSync`. It is unflagged on Node 22.13+ and
    on Node 24, and the repo's `engines` is `^24`. Node 24.22.1 printed no
    experimental warning in the spikes.
  - Bun: `bun:sqlite`.
  - Deno: `node:sqlite`.
  - There is no native dependency, no `better-sqlite3` and no
    `node-gyp`.
- **Load it at runtime** with `process.getBuiltinModule('node:sqlite')`, or
  a guarded dynamic import on Bun. That keeps framework bundlers such as
  Turbopack, webpack and Nitro from trying to resolve or polyfill
  `node:sqlite`. `sqlite` is a prefix-only builtin and is missing from older
  `builtin-modules` lists. Our own `node-module-esbuild-plugin` already
  treats `bun:*` and `node:*` as runtime builtins.
- **Schema versioning:** `PRAGMA user_version` plus a `migrations` array.
  `version.txt` stays for the existing "data written by another version"
  warning.

### 4.2 Schema

```sql
-- runs: one row per run, including its log counters
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, tag TEXT, workflow_name TEXT NOT NULL,
  status TEXT NOT NULL, spec_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,            -- last allocated event position
  seq_in_band INTEGER NOT NULL,    -- spec 9 fence counter
  event_count INTEGER NOT NULL,    -- max_events limit
  deployment_id TEXT, execution_context TEXT, input BLOB, output BLOB, error BLOB,
  attributes TEXT, encryption_public_key TEXT, expired_at INTEGER,
  created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX runs_list ON runs(tag, status, created_at);
CREATE INDEX runs_by_name ON runs(workflow_name, created_at);

-- events: the log; position = seq; event_id = slotToEventId(seq)
CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES runs ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL, correlation_id TEXT,
  in_band INTEGER NOT NULL, data BLOB, created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
CREATE INDEX events_corr ON events(run_id, correlation_id, seq);

CREATE TABLE steps (run_id TEXT, step_id TEXT, step_name TEXT, status TEXT, attempt INTEGER,
  input BLOB, output BLOB, error BLOB, retry_after INTEGER, inline INTEGER, creator_message_id TEXT,
  created_at INTEGER, started_at INTEGER, completed_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (run_id, step_id)) WITHOUT ROWID;
CREATE TABLE waits (run_id TEXT, wait_id TEXT, status TEXT, resume_at INTEGER,
  created_at INTEGER, completed_at INTEGER, PRIMARY KEY (run_id, wait_id)) WITHOUT ROWID;

CREATE TABLE hooks (hook_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, token TEXT NOT NULL,
  status TEXT NOT NULL, metadata BLOB, is_start_hook INTEGER, retention_until INTEGER,
  created_at INTEGER, disposed_at INTEGER, force_claimed_by TEXT);
CREATE INDEX hooks_by_run ON hooks(run_id);
-- token uniqueness across runs, including retention-reserved tokens
CREATE TABLE hook_tokens (token TEXT PRIMARY KEY, hook_id TEXT NOT NULL, run_id TEXT NOT NULL,
  reserved_until INTEGER);
CREATE TABLE hook_resumes (run_id TEXT, resume_id TEXT, hook_id TEXT, seq INTEGER, payload_digest TEXT,
  PRIMARY KEY (run_id, resume_id)) WITHOUT ROWID;

-- durable queue
CREATE TABLE messages (
  id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, tag TEXT, payload BLOB NOT NULL,
  route TEXT, lane TEXT,                 -- runId for spec 9 orchestrator messages, else NULL
  idempotency_key TEXT UNIQUE, visible_at INTEGER NOT NULL,
  lease_owner TEXT, lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
  delivery_count INTEGER NOT NULL DEFAULT 0, handoffs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX messages_ready ON messages(visible_at);
CREATE INDEX messages_lane ON messages(lane, lease_until);
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, message_id TEXT, expires_at INTEGER);

-- streams: total order per stream, assigned at commit
CREATE TABLE stream_chunks (run_id TEXT, name TEXT, idx INTEGER, data BLOB, eof INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, PRIMARY KEY (run_id, name, idx)) WITHOUT ROWID;

CREATE TABLE snapshots (run_id TEXT PRIMARY KEY, envelope BLOB NOT NULL, updated_at INTEGER);
```

Tags, used for vitest isolation, become a column. A tagged `clear()` is
`DELETE … WHERE tag = ?` in one transaction, which cannot touch another
tag's rows (#4742). An untagged `clear()` deletes the file.

### 4.3 `events.create`

```text
db.transaction(() => {
  run = SELECT * FROM runs WHERE run_id = ?           -- absent only for run_created / resilient run_started
  if inBand: if params.expectedSeqInBand != run.seq_in_band -> throw InBandSupersededError (nothing written)
  validate(run, entityRows, event)                    -- shared state machine (4.6); throws Conflict/RunExpired/TooEarly
  seq = run.seq + 1
  INSERT INTO events (...)                            -- position = seq, never a hole, never a bump loop
  apply(event) -> UPSERT runs/steps/waits/hooks/hook_tokens/hook_resumes
  UPDATE runs SET seq = seq, seq_in_band = seq_in_band + inBand, event_count = event_count + 1
  delta = sinceCursor ? SELECT events WHERE run_id = ? AND seq > cursor : undefined
})
```

What follows from that structure:

- **No partial writes.** Every class A row in section 2 becomes an
  impossible state. All the recovery code paths can be deleted:
  `restoreMissingRunCreated`, claim rebuilds, `retargetHookCreatedClaim`,
  `repairHookEntityFromPersistedEvent`, `settledInBandCount`,
  staging-slot reaping and the claim takeover in #5219.
- **Dense positions** come for free: `seq + 1` under the write lock. Spec 7
  `noop` gap closing is never needed, because a refused or crashed write
  allocates nothing.
- **Idempotent duplicates** use the same rule everywhere:
  - `step_created` for an existing step: the primary key conflicts and the
    write throws `EntityConflictError`.
  - Duplicate `hook_created` for the same hook and token: the existing event
    is returned.
  - `hook_received` with a known `resumeId`: the event is found through
    `hook_resumes`.
- **Hook token conflicts** are an `INSERT` into `hook_tokens` that hits the
  primary key.
  - Plain conflict: write a `hook_conflict` event.
  - Releasable token (disposed, or the run is terminal and past
    retention): delete the token row and insert again, in the same
    transaction.
  - Forced claim: in one transaction, append `hook_disposed` to the
    victim's log (with its own seq), mark the victim hook
    `force_claimed_by`, move the token row, and append this run's
    `hook_created`. Today this is about ten ordered file writes under two
    locks (#4924).
- **`hook_received` against a concurrent termination or dispose** cannot
  race, because the transaction reads the run status and hook status it
  validates against (#2808, #2987).
- **Terminal run events** set the status and delete the run's `waits`, its
  live `hooks` and their `hook_tokens` (minding retention) in the same
  transaction. `experimental_retention: 0` scrubs the payload columns there
  too.
- **`createBatch`** runs as one transaction with per-item savepoints, so a
  refused item refuses the later items for the same correlation id and
  leaves the rest alone.
- **Wake-ups after commit:**
  - `waitForTerminalStatus` and stream readers in the same process get an
    in-process `EventEmitter` signal.
  - Other processes poll every 100 ms, checking `PRAGMA data_version`
    first, which costs almost nothing when nothing changed.

### 4.4 Durable queue

- **`queue()`** inserts a row. `delaySeconds` sets `visible_at`. A key
  already in `idempotency_keys` (24 h) returns the existing message id.
- **Consumers.** Every World instance whose `start()` ran, and that has a
  delivery target (a `registerHandler` or a base URL/port), runs a consumer
  loop. A producer-only process, such as a script or test calling `start()`
  against a running dev server, only enqueues. This is the class of #5145
  fixed by construction: the script's run is delivered by the dev server,
  with no in-memory gate in either process.
- **Claim:** one short transaction (from the spike, section 7):

  ```sql
  UPDATE messages SET lease_owner = :owner, lease_until = :now + :lease, delivery_count = delivery_count + 1
  WHERE id = (SELECT m.id FROM messages m
              WHERE m.visible_at <= :now AND (m.lease_until IS NULL OR m.lease_until < :now)
                AND (m.lane IS NULL OR NOT EXISTS (
                      SELECT 1 FROM messages o WHERE o.lane = m.lane AND o.id <> m.id AND o.lease_until >= :now))
              ORDER BY m.visible_at, m.id LIMIT 1)
  RETURNING *;
  ```

  The `lane` clause is the spec 9 single-orchestrator guarantee across all
  processes. Delayed messages in a lane hold nothing, as with Graphile
  named queues in world-postgres.
- **Leases and heartbeats.** The lease is 15 s, extended every 5 s while the
  delivery runs. There is no delivery deadline, so long inline steps are
  fine (#4351). If the consumer dies, the lease lapses within 15 s and
  another consumer, or the restarted process, redelivers. That replaces
  #4940's orphaned-step release, the 860 s inline lease wait and #4780.
  To make this faster after a restart, a consumer started on the same host
  can immediately expire leases whose `lease_owner` names a pid that
  `kill(pid, 0)` says is gone. This only speeds things up; correctness
  never depends on it.
- **Responses:**
  - `{ timeoutSeconds: n }`: update `visible_at` and clear the lease. Same
    message id, `attempt` unchanged.
  - Handoff on spec 9: increment `handoffs`.
  - Success: `DELETE` the row.
  - Failure: backoff through `visible_at`, using the existing 5 s × 32,
    then doubling to 60 s.

  Each of these is one statement.
- **Concurrency.** `WORKFLOW_LOCAL_QUEUE_CONCURRENCY` stays as the number of
  leases one process holds at once. There is no semaphore across sleeps,
  because sleeping messages are rows, not promises.
- **Restart recovery.** Delayed messages, wait timers and backoffs survive a
  restart, because they are rows. `reenqueueActiveRuns` becomes a
  reconciliation sweep: enqueue a run only if it is non-terminal and has no
  message at all. That covers runs from before the upgrade and messages a
  user deleted by hand. It no longer re-invokes every active run.
- **`close()`** stops claiming and aborts in-flight deliveries. Their leases
  lapse, or are released explicitly when the abort is clean.

### 4.5 Streams

- **`write`** is a transaction: `idx = COALESCE(MAX(idx), 0) + 1` for
  `(run_id, name)`, then insert. Chunks are totally ordered at commit, with
  no holes and no duplicates (class F). `writeMulti` is one transaction.
- **`close`** inserts an EOF row. `list` is
  `SELECT DISTINCT name … WHERE run_id = ?`, so there is no index file and
  no lock (#4754).
- **Readers.**
  - Same process: an in-process emitter.
  - Other processes: poll `WHERE run_id = ? AND name = ? AND idx > :last`,
    which is an index seek regardless of stream length (#4830). A reader
    that opens mid-write sees exactly the committed prefix, then the
    suffix: no reordering logic and no live buffer.
  - A `startIndex` past the tail simply waits (#5092).
- **Purge** for retention is a `DELETE` plus a tombstone row.

### 4.6 One state machine, shared with world-sim

`packages/world-sim/src/store.ts` already contains "the single copy of the
event → entity state machine" (`applyEvent`, kept separate from
validation), and its comments say it mirrors world-local. The proposal is to
extract `validateEvent(state, event)` and `applyEvent(state, event)` into
`@workflow/world` as an internal module. world-local and world-sim would use
the same copy, and world-postgres could adopt it later. world-local's
transaction then becomes "load rows → validate → apply → write rows" in
about a thousand lines, instead of today's 4.8k-line `events-storage.ts`.

### 4.7 What stays the same

- The World interface, capabilities and spec versions. `inBandFence`,
  `atomicStartHook`, `hookResumeDedup`, `hookForceClaim` and
  `maxConcurrency` are all still declared.
- The HTTP delivery path, headers and route registration.
- Startup ordering: the World starts at server boot, recovery is gated by
  `recoverActiveRuns`, and tagged isolation stays.
- `workflow inspect` and the web UI, which read through the World API.

### 4.8 What gets deleted

| Area | Files (today) |
|---|---|
| Lock files and takeover | `storage/fence-lock.ts`, the claim and marker handling in `storage/helpers.ts`, `windows-retry.ts`, the `proper-lockfile` dependency |
| Crash repair | `restoreMissingRunCreated`, claim rebuild and retargeting, resume convergence, staging slots, `settledInBandCount`, most of `orphaned-steps.ts`, the #5219 takeover rules |
| Indexes over files | `storage/hook-index.ts`, `hooks/token-index`, `hooks/id-index`, `hooks/by-run`, the backfill marker |
| File placement | `stream-chunk-place.ts`, slot draw and bump loops, `fs.ts` (paginated directory queries, created-files caches, symlink guards) |
| In-memory coordination | step, hook and run locks, the in-process fence lock, `runGate` / `handlerRunGate`, the `async-sema` usage across sleeps |

Today that is 12.6k lines of source and 19.8k lines of tests. I expect the
rewrite to be roughly 3–4k lines of source. Many of today's tests are crash
reproducers for windows that no longer exist. The behaviour tests (hooks,
fence, start hook, retention, streams, queue semantics) carry over, and the
conformance suites in `@workflow/world-testing` and
`@workflow/world/test-support` are the acceptance bar.

---

## 5. Risks and open questions

1. **Network and VM-shared filesystems.** WAL needs shared memory, so it
   does not work when processes on different machines or VMs share the
   file over NFS or SMB. Docker Desktop bind mounts shared between the host
   and a container are the likely case. Single-process use on such a mount
   is fine.
   - Mitigation: detect the case and fall back to `journal_mode=DELETE`
     (slower, still correct), and document it.
   - Today's design is also unsafe there, because its pid checks are
     per-host.
2. **Runtime floor.** `node:sqlite` needs Node ≥ 22.13 unflagged. The repo
   targets Node 24 and CI runs only 24. Question: do we promise Node 20 or
   early Node 22 for world-local? If so, we need a clear error or an
   optional `better-sqlite3` fallback.
3. **Bun.** There is a `bun:sqlite` adapter, but nothing in CI exercises
   world-local on Bun today. Question: should we add a Bun smoke job?
4. **Agent introspection.** Inspecting with `cat events/*.json` turns into
   `sqlite3 .workflow-data/world.db "select seq,type,correlation_id from events where run_id='…'"`.
   As the thread noted, models are equally at home with either. We could
   still ship a `workflow inspect --json` or a `world-local dump` helper.
5. **Upgrade.** The proposal is to start fresh: on first open, the old JSON
   layout is left in place, or deleted with a warning, as 5.1.0 did when it
   changed layout. An importer is possible, but it would have to replay the
   very half-written states this design exists to avoid. Question: is
   wiping local dev data acceptable for this release?
6. **Write throughput.** There is a single write lock, measured at about
   22k transactions per second across 8 processes. That is about two orders
   of magnitude above what a local dev server does. Transactions must stay
   synchronous and short. Never `await` inside one; the synchronous drivers
   make that impossible to get wrong by accident.
7. **Bundled copies.** Two copies of world-local in one process (#3728) open
   two connections. That is safe, because SQLite serializes them, but the
   in-process emitter should live on `globalThis`, keyed by the db path.
8. **Release vehicle.** This could be a minor bump with a data reset, as in
   5.1.0, or a major bump of `@workflow/world-local`. Question: which one?

---

## 6. Plan

1. **Extract the shared state machine** from `world-sim/src/store.ts` into
   `@workflow/world` (internal export). world-sim switches to it with no
   behaviour change.
2. **Build the SQLite storage** in a new `src/sqlite/` tree: driver adapter,
   schema and migrations, `events.create`/`list`/`get`/
   `listByCorrelationId`, runs, steps and hooks reads, retention,
   snapshots.
   - Gate: `@workflow/world-testing` (spec 8 and spec 9 suites),
     `inBandFenceConformance` and `atomicStartHookConformance` pass.
   - Port the hook, start-hook, retention and fence behaviour tests.
   - Add one `SIGKILL` fuzz test that kills writers at random and checks
     "every row has its event, positions are dense, `integrity_check` is ok",
     in place of the per-window crash reproducers.
3. **Durable queue** with leases, heartbeats, orchestrator lanes,
   idempotency keys and producer-only processes. Port the queue semantics
   tests (backoff, handoffs, `timeoutSeconds`, `deliveryCount`,
   `registerHandler` / `registerRoute`, `close()`). Add a test that kills
   consumers during deliveries and asserts lanes never overlap.
4. **Streams** on `stream_chunks`. Port the ordering tests from
   #4909/#5069 unchanged; they should pass without any special handling.
5. **Remove the filesystem implementation** and `proper-lockfile`. Update
   `docs/content/worlds/v5/local.mdx` and `building-a-world.mdx`, add the
   changeset, and close the class A–H issues still open: #5083, #5161,
   #5176, #4830, #4203, and possibly #4728. Supersede #5219, #5153, #5025,
   #5092 and #4780.

An optional transition step: ship steps 2–4 behind
`WORKFLOW_LOCAL_STORAGE=sqlite` for one release, with the e2e matrix run on
both, then flip the default. Given that local data is disposable, I would
skip the flag and land it in one release, behind the conformance suites and
e2e.

### Configuration this makes unnecessary

The configuration clean-up is tracked separately. This design removes the
need for:

- the stale and takeover timing knobs, of which there are none public today
  but several constants;
- `WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS` / `WORKFLOW_LOCAL_BODY_TIMEOUT_MS`
  (replaced by leases);
- most of the reason for `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` (recovery is
  a no-op sweep).

---

## 7. Evidence: spikes run for this proposal

Environment: Node v24.22.1, `node:sqlite`, SQLite 3.53.4, Linux devbox. Each
writer process runs, per write: `BEGIN IMMEDIATE`; read the run's next
position; insert a step row (`ON CONFLICT DO NOTHING`); insert the event;
`COMMIT`. These are the same shapes as §4.3.

| Scenario | Result |
|---|---|
| 1 process × 4,000 writes, 8 runs | 22.4k writes/s, p50 0.02 ms, p99 0.08 ms |
| 4 processes × 2,000 writes, 8 runs | 21.5k writes/s overall, p99 about 1.2 ms per process, no gaps |
| 8 processes × 1,000 writes, 2 hot runs | 22.9k writes/s overall, p99 up to 3.0 ms, no gaps |
| 50 rounds × 4 writers, all `SIGKILL`ed at random (200 kills), 45,967 events committed | 0 step rows without their event, 0 runs with a gap in seq, `integrity_check = ok`, no stall after a kill |
| Queue: 3,000 messages over 10 runs (lanes), 6 consumer processes, 15 consumers `SIGKILL`ed mid-delivery and replaced | All messages delivered in 2.5 s. 0 overlapping deliveries on one run (each consumer holds an `inflight(run_id)` row from claim to ack, and overlap would have been detected). Killed consumers' messages were redelivered after their 300 ms lease. |

These spikes measure the storage and lease primitives, not a full World. The
numbers are an upper bound on overhead, not a benchmark of the rewrite.
