# @workflow/world-local

Workflow backend for local development and testing, stored in one SQLite
database (`<dataDir>/world.db`, default `.workflow-data/world.db`), opened with
the runtime's built-in driver: `node:sqlite` (Node.js 22.13 or later) or
`bun:sqlite`.

Used by default on `next dev` and `next start`.

- **Storage.** Every `events.create` is one transaction: the event, and every
  change it makes to its run, step, wait and hook, commit together or not at
  all. Writers in several processes on one data directory are ordered by
  SQLite's write lock, which the OS releases when a process exits.
- **Queue.** Messages are rows of the same database, delivered over HTTP to the
  app (or to an in-process handler) by a leased consumer in each process that
  uses the World. They survive restarts. A single-orchestrator (spec 9) run's
  orchestrator deliveries go one at a time across every process.
- **Streams.** Chunks are numbered in the transaction that writes them, so a
  reader gets them in order; readers in other processes poll for new rows.

To look at the data, open the database with any SQLite client:

```bash
sqlite3 .workflow-data/world.db "select seq, event_type, correlation_id from events where run_id = 'wrun_…' order by seq"
```

The local World resumes hooks by writing an event and queuing workflow
execution. It does not implement `world.invoke()` or enable
`capabilities.invoke`.

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
