# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Connection failures

Backend connection failures and interrupted event streams follow existing retry policies, including failures with unrecognized error codes. Repeated HTTP/2 session failures rebuild the shared events connection pool. Invalid backend URL protocols, embedded credentials, Fetch-blocked ports, and unsupported request headers fail immediately. Interrupted event writes retain their existing in-process retries; caller cancellations are excluded.

See [Backend connection failures](https://workflow-sdk.dev/docs/foundations/errors-and-retries#backend-connection-failures) for retry behavior and diagnostics.

## Experimental direct invocation

Set `WORKFLOW_VERCEL_INVOKE_URL` to the full workflow execution endpoint URL on
producers and receivers, or pass `invoke: { endpoint }` to `createWorld()`.
Invocation is disabled by default. Enabling it implements `invoke` and declares
`capabilities.invoke`, following the shared World contract.

```ts
import { createWorld } from '@workflow/world-vercel';

const world = createWorld({
  invoke: { endpoint: 'https://example.vercel.app/.well-known/workflow/v1/flow' },
});
```

The endpoint must support platform affinity and deployment selection. Requests
set `x-vercel-affinity-id` to the first 16 bytes of SHA-256(runId), hex encoded,
and `x-deployment-id` to the run's pinned deployment. Deployment selection uses
Vercel Skew Protection routing, subject to its enablement and retention limits.
The receiver rejects delivery to the wrong deployment. An async endpoint
resolver receives `{ runId, deploymentId, region }`; region identifies the run's
data/queue region, which may differ from compute placement.

Invoke sends one direct CBOR POST and waits for the SDK handler's result. The
receiver authenticates same-project/environment workload OIDC and processes the
input through a private per-run in-memory queue. The sender uses
`@vercel/oidc`, or `invoke.getToken()`, for its credential. Ordinary workflow
execution still uses VQS, with matching affinity headers on orchestration sends.
Steps and health checks retain their parallel delivery path.

The receiver processes inputs while an inline step waits. A cold input starts
a continuation registered with `waitUntil`. The existing WebSocket event-channel
lifecycle, delayed-wake scheduling, and queue error backoff also apply to these
continuations. Fresh backend hook deduplication attestation is required before a
new hook write; disposed-hook retries must match a retained event.

The default response timeout is 30 seconds, configurable up to 120 seconds.
Request and response bodies are limited to 1 MiB each. Each handler permits 64
live run states, 32 pending inputs per run, and 128 pending inputs in total.
Full queues return 429. The sender does not retry POST automatically; a custom
dispatcher must preserve that policy. Retry an uncertain input with its original
idempotency key and payload.

Instance loss discards unprocessed inputs. A lost response leaves processing
unknown, and an accepted input does not guarantee a later continuation succeeds.
Continuation failures are logged; recovery depends on existing runtime recovery
or another execution request. The implementation adds no durable input storage
or stale-writer fencing. Test placement and deployment routing on the actual
endpoint before relying on affinity for single-runner exclusion.

## Custom dispatcher

Storage and queue HTTP requests default to a shared undici `RetryAgent` that handles connection pooling and retries. Direct invocation does not use this retrying default. Pass a custom `dispatcher` to override the HTTP dispatcher, for example, to tune undici on newer Node.js runtimes:

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
