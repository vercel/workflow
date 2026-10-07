# @workflow/world-local

Filesystem-based workflow backend for local development and testing.

Stores workflow data as JSON files on disk and provides in-memory queuing. Automatically detects development server port for queue transport.

Used by default on `next dev` and `next start`.

The local World continues to resume hooks by writing an event and queuing
workflow execution. It does not implement `world.invoke()` or enable
`capabilities.invoke`.

Concurrent creation of the same hook across storage instances sharing a data
directory publishes one `hook_created` event. A losing creator reports an
entity conflict without appending another creation, including when a retry
publishes before the original token-claim owner.

Its HTTP queue handler supports receiving `invoke: true` messages and returns
the callback's value as `{ result }`. For example, a callback returning
`{ timeoutSeconds: 5 }` produces `{ result: { timeoutSeconds: 5 } }`. The value is
response data; the receiver does not schedule another execution for that
invocation.

## Programmatic configuration

```ts
import { createWorld } from '@workflow/world-local';

const world = createWorld({
  dataDir: './custom-workflow-data',
});
```

## Data directory layout

A data directory keeps event and step files in one of two layouts, recorded
in `<dataDir>/layout.json` (no file means flat):

- **Run-scoped**: one directory per run, `events/<runId>/<runId>-<eventId>.json`
  and `steps/<runId>/<runId>-<stepId>.json`. Reading or appending to a run
  lists only that run's directory, so the cost stays proportional to the run.
  `start()` selects it for a new data directory.
- **Flat**: every file directly in `events/` and `steps/`, as releases before
  run-scoped storage wrote it. Each per-run read lists the whole directory, so
  it slows down as runs accumulate. Existing flat data directories keep
  working unchanged: reads and writes never convert them, so older releases,
  read-only mounts and other tools that read the files keep working.

### Converting a flat data directory

Conversion is an explicit, offline step. Stop every process using the data
directory (dev server, `workflow` CLI and web UI, vitest), then run:

```sh
npx -p @workflow/world-local workflow-local-layout migrate <dataDir>
```

or start the owning process with `migrateLayout: true` (or
`WORKFLOW_LOCAL_MIGRATE_LAYOUT=1`). Conversion takes an exclusive lock and
refuses, without changing anything, while another process of this package
has the data directory open; processes of older releases cannot be detected,
so they must be stopped first. Files are renamed, never overwritten. While
it runs, and after an interruption, `layout.json` records `migrating` and
processes refuse to open the data directory until the same command is run
again. A file that cannot be placed (a different file already at the
destination, or one whose run cannot be determined) is reported and left in
place; the conversion completes once it is resolved, or with `--quarantine`,
which moves such files to `.layout/quarantine/`. On APFS a rename takes about
0.35 ms (about 20 s for 60k files).

`workflow-local-layout status <dataDir>` prints the layout as JSON. Exit
codes: 0 done, 1 incomplete (files listed on stderr), 2 usage or other error,
3 refused because the data directory is in use.

### Downgrading

Releases before run-scoped storage read only the flat layout and would see
converted runs as empty. Before downgrading, with this release still
installed and every process stopped, run:

```sh
npx -p @workflow/world-local workflow-local-layout flatten <dataDir>
```

It moves every file back under its original name and removes `layout.json`
only once no run directory holds a file; otherwise it exits 1 and keeps the
data directory closed (`flattening`) until the listed files are resolved.

To compare layouts on a copy of a real data directory:

```sh
# Copy-on-write clone where supported, padded to 50k event files.
# The destination must be a new path outside the source.
node scripts/benchmark-layout.mjs prepare <dataDir> <benchDir> 50000
# For a run-scoped build, convert the copy first:
#   node bin/workflow-local-layout.mjs migrate <benchDir>
node scripts/benchmark-layout.mjs run <world-local>/dist/index.js <benchDir> <label>
```
