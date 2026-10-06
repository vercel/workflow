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

Event and step files are stored in one directory per run:
`events/<runId>/<runId>-<eventId>.json` and
`steps/<runId>/<runId>-<stepId>.json`. Reading or appending to one run lists
only that run's directory, so the cost stays proportional to the run instead
of to every run the data directory has ever held.

Data directories written by 5.0.1 and earlier keep every file directly in
`events/` and `steps/`. They are converted on first use: before the first
storage call in a process, each flat file is renamed into its run's
directory. Renames never overwrite, so the conversion is safe to interrupt
and to run from several processes at once. It takes roughly 0.35 ms per file
on APFS (about 20 s for 60k files) and logs a notice from 1,000 files up.

- **Stop older writers first.** The conversion runs once per process. Files
  that an older version keeps writing to the flat layout afterwards are only
  picked up on the next process start.
- **Downgrading** requires moving the files back. Stop every process using the
  data directory, then run
  `node node_modules/@workflow/world-local/scripts/flatten-layout.mjs <dataDir>`
  (or `scripts/flatten-layout.mjs` from this repository). It never
  overwrites a file already at the flat path.

To compare layouts on a copy of a real data directory:

```sh
# Copy-on-write clone where supported, padded to 50k event files.
# The destination must be a new path outside the source.
node scripts/benchmark-layout.mjs prepare <dataDir> <benchDir> 50000
node scripts/benchmark-layout.mjs run <world-local>/dist/index.js <benchDir> <label>
```
