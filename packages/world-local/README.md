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

If run creation is interrupted after the run record is saved, the next lifecycle
event for that pending run restores the missing `run_created` event from the saved
record before it continues. Recovery only repairs an empty event log. A start
rejects non-empty history rather than guessing a missing prefix, but cancelling or
failing the run still succeeds.

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
