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

## Queue authentication

The queue delivers messages by POSTing them to the app's flow route, so the
route's handler authenticates each delivery with a shared secret before reading
it. Set `WORKFLOW_QUEUE_SECRET` (or the `queueSecret` option) to the same random
value, at least 32 characters, on every process that sends or receives queue
messages. Without one, the handler accepts unauthenticated deliveries only when
`NODE_ENV` is `development` or `test` (`next dev`, Vitest), and answers every
delivery with `503` otherwise, including under `next start`.

## Programmatic configuration

```ts
import { createWorld } from '@workflow/world-local';

const world = createWorld({
  dataDir: './custom-workflow-data',
});
```
