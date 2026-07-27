# @workflow/world-local

Filesystem-based workflow backend for local development and testing.

Stores workflow data as JSON files on disk and provides in-memory queuing. Automatically detects development server port for queue transport.

Used by default on `next dev` and `next start`.

## Programmatic configuration

```ts
import { createWorld } from '@workflow/world-local';

const world = createWorld({
  dataDir: './custom-workflow-data',
});
```

## Run-tree purge

The local World supports `purgeRunTree()`. It durably records a deletion
manifest before removing terminal root and descendant runs, events, steps,
hooks and indexes, waits, and stream data. The manifest fences later writes
and allows an interrupted purge to finish after restart.
