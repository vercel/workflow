# @workflow/world-vercel

Resolved hook resumes use `/api/v4/runs/:runId/events/hook_received/resolved`.
This HTTP-only endpoint requires atomic resume deduplication, including when
the normal event transport uses WebSockets. Older servers and the dedup kill
switch reject before writing. The adapter does not retry this request: a lost
response must not become a safe-looking rejection after a backend rollback.

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Concurrent hook registrations

Concurrent independent hook registrations use the existing single-event
requests. The Node.js runtime defers per-request history catch-up and reconciles
the committed events after all requests settle. The adapter supplies an optional
`eventCursor` in Vercel's cursor format and honors resolved hook metadata for this
path. A consecutive suffix needs no history read; missing or intervening events
retain the normal reload before continuation. No server upgrade or batch
registration endpoint is required.

The runtime applies this optimization only to hooks-only suspensions whose
registrations are all independent. Mixed suspensions, forced claims, and
same-token lifecycle operations keep the normal catch-up path without resolving
metadata for unused mutation responses. Runtime spans record
`workflow.concurrent_hooks.carried_forward` and, on fallback,
`workflow.concurrent_hooks.fallback_reason`; debug logs include the same outcome.

## Connection failures

Backend connection failures and interrupted event streams follow existing retry policies, including failures with unrecognized error codes. Repeated HTTP/2 session failures rebuild the shared events connection pool. Invalid backend URL protocols, embedded credentials, Fetch-blocked ports, and unsupported request headers fail immediately. Interrupted event writes retain their existing in-process retries; caller cancellations are excluded.

See [Backend connection failures](https://workflow-sdk.dev/docs/foundations/errors-and-retries#backend-connection-failures) for retry behavior and diagnostics.

## Events channel

Event writes go over a per-run WebSocket (the default `WORKFLOW_EVENTS_TRANSPORT`;
with `http`, only for the workflows listed in
`WORKFLOW_EVENTS_TRANSPORT_WS_OVERRIDE_WORKFLOWS`) only while that run's
channel is open. The queue handler opens it for each
delivery, so workflows need nothing extra. Code that writes a run's events
outside a delivery (a custom driver, a long-lived process) opens and releases
it itself; otherwise those writes go over HTTP:

```ts
import { createWorld, openEventsChannel } from '@workflow/world-vercel';

const world = createWorld();
const release = openEventsChannel(runId);
try {
  await world.events.create(runId, event);
} finally {
  release?.();
}
```

It returns `undefined`, and writes stay on HTTP, when the transport is
disabled or the World cannot hold a socket (a `projectConfig` World, as the
CLI uses).

## Stream writer sockets

Stream writes upgrade to a WebSocket by default; set
`WORKFLOW_STREAMS_TRANSPORT=http` to keep them on HTTP. A writer's first two
write groups go over HTTP while the socket opens in the background, and a writer
whose upgrade the server declines stays on HTTP.

Releasing a writer after its writes drain retires its socket without closing
the shared stream. Reacquiring that handle continues over HTTP; a new step's
writer can upgrade independently. Released writers do not keep idle WebSockets or reconnect them in the background.

Step-local `getWritable()` handles release their transport at step completion,
not between acquire/write/release cycles within the step. External
`Run#getWritable()` handles release it on the first observed unlock after pending
writes drain; subsequent writes through that same handle stay on HTTP. To retain
WebSocket transport across an external streaming burst, hold the writer lock
until the burst finishes. Call `releaseLock()` when finished contributing, not
`close()`, unless you intend to close the shared stream.

## Custom dispatcher

HTTP requests (including the queue) use shared undici dispatchers for connection pooling. Pass a custom `dispatcher` to override them, for example, to tune undici on newer Node.js runtimes:

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
