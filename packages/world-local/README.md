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

## Experimental journals

Local World implements the optional `world.journals` capability for opaque
state that must outlive an individual workflow run. Commits use optimistic
revisions and idempotency keys. Revision files and directory metadata are
synced before a commit resolves on POSIX filesystems; directory syncing is
best-effort on Windows.

```ts
const created = await world.journals.commit(
  'session:123',
  new TextEncoder().encode('{"status":"idle"}'),
  { expectedRevision: null, idempotencyKey: 'create' }
);

await world.journals.commit(
  'session:123',
  new TextEncoder().encode('{"status":"running"}'),
  { expectedRevision: created.revision, idempotencyKey: 'claim-turn' }
);
```
