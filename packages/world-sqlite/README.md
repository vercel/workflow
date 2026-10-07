# @workflow/world-sqlite

A local World for Workflow SDK that keeps runs, events, steps, hooks, waits,
streams and snapshots in a single SQLite database instead of a directory of
JSON files. It behaves like
[`@workflow/world-local`](https://github.com/vercel/workflow/tree/main/packages/world-local)
at the World API level and reuses its HTTP queue; only storage differs.

It uses the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
module, so there is nothing native to install.

## Requirements

- Node.js 24 or later (`node:sqlite` exists from 22.13, but Node 22 prints an
  experimental warning and may bundle an older SQLite).
- **SQLite 3.51.3 or later**, as bundled by the running Node.js. Earlier
  versions have a WAL-reset bug that can corrupt a database written by several
  connections at once. The world checks `sqlite_version()` when it is created
  and throws `SqliteVersionError` if the bundled SQLite is older.

## Usage

Select it as the target world:

```sh
WORKFLOW_TARGET_WORLD=@workflow/world-sqlite
```

or create it directly:

```ts
import { createWorld } from '@workflow/world-sqlite';

const world = createWorld({ dataDir: '.workflow-data' });
```

### Configuration

| Option / env var | Default | |
| --- | --- | --- |
| `dbPath` / `WORKFLOW_SQLITE_PATH` | `<dataDir>/workflow.sqlite` | Database file. |
| `dataDir` / `WORKFLOW_LOCAL_DATA_DIR` | `.workflow-data` | Directory holding the database. |
| `tag` | none | Scopes the instance's data; `clear()` then deletes only that tag's rows. |
| `recoverActiveRuns` / `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` | `true` | Re-enqueue active runs on `start()`. |
| `port`, `baseUrl` / `WORKFLOW_LOCAL_BASE_URL`, `streamFlushIntervalMs` | as world-local | Queue and stream settings, passed to world-local's queue. |

`WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS` and
`WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS` are honoured as in world-local.

The database uses WAL journaling, a 5 s busy timeout, and `BEGIN IMMEDIATE`
for every write, so several processes on the same machine (a dev server, the
CLI, the web UI) can share one store. Stream readers in another process see
new chunks within ~100 ms: they poll, and only query when
`PRAGMA data_version` reports a commit from another connection.

An existing world-local JSON store is not imported; a new database starts
empty.

## Where not to put the database

WAL mode needs shared memory and POSIX locking that behave the same for every
process using the file. **Keep the database on a local disk.** Do not put it:

- on a network filesystem (NFS, SMB/CIFS, most cloud-synced folders), where
  locking is unreliable and WAL is not supported;
- on a virtualized mount shared between a host and a guest, such as a
  Docker-on-macOS bind mount or a WSL path under `/mnt/c`, when processes on
  both sides write to it at the same time.

Either can corrupt the database. Inside a container or WSL, keep the data
directory on the guest's own filesystem.

## Storage notes

- A step's input is stored once, on its `step_created` event, and joined into
  the step on read.
- Binary payloads are stored as bytes, not base64.
- Deleting runs frees pages inside the file but does not shrink it; an
  untagged `clear()` runs `VACUUM`.
