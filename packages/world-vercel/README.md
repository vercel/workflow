# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Run-tree purge availability

This client does not advertise `runTreePurge`. Supporting it requires an
atomic `DELETE /v2/runs/:rootRunId/tree` implementation in the separately
owned `vercel/workflow-server`, including server-owned snapshots, blob
references, and durable post-delete write fencing. That server source is not
part of this repository, so the adapter must not report the capability until
the server endpoint is implemented and deployed.

## Custom dispatcher

HTTP requests (including the queue) default to a shared undici `RetryAgent` that handles connection pooling and retries. Pass a custom `dispatcher` to override it — e.g. to tune undici on newer Node runtimes:

```ts
import { Agent } from 'undici';
import { createWorld } from '@workflow/world-vercel';
import { setWorld } from '@workflow/core/runtime';

setWorld(createWorld({ dispatcher: new Agent({ connections: 16 }) }));
```

## Caller user agent

Pass a `User-Agent` header to append a caller-specific product token while
preserving the world-vercel token:

```ts
import { createWorld } from '@workflow/world-vercel';

const world = createWorld({
  headers: { 'User-Agent': 'my-framework/1.2.3' },
});
```
