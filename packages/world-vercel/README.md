# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Connection failures

Backend connection failures and interrupted event streams follow existing retry policies, including failures with unrecognized error codes. Repeated HTTP/2 session failures rebuild the shared events connection pool. Invalid backend URL protocols, embedded credentials, Fetch-blocked ports, and unsupported request headers fail immediately.

See [Backend Connection Failures](https://useworkflow.dev/docs/foundations/errors-and-retries#backend-connection-failures) for retry behavior and diagnostics.

## Custom dispatcher

HTTP requests (including the queue) default to a shared undici `RetryAgent` that handles connection pooling and retries. Pass a custom `dispatcher` to override it — e.g. to tune undici on newer Node runtimes:

```ts
import { Agent } from 'undici';
import { createVercelWorld } from '@workflow/world-vercel';
import { setWorld } from '@workflow/core/runtime';

setWorld(createVercelWorld({ dispatcher: new Agent({ connections: 16 }) }));
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
