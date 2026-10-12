# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

## Connection failures

Backend connection failures and interrupted event streams follow existing retry policies, including failures with unrecognized error codes. Repeated HTTP/2 session failures rebuild the shared events connection pool. Invalid backend URL protocols, embedded credentials, Fetch-blocked ports, and unsupported request headers fail immediately. Interrupted event writes retain their existing in-process retries; caller cancellations are excluded.

See [Backend connection failures](https://workflow-sdk.dev/docs/foundations/errors-and-retries#backend-connection-failures) for retry behavior and diagnostics.

## HTTP stream append retries

HTTP stream appends using the built-in undici dispatcher retry confirmed 429
rejections with fresh requests built from preserved bytes, at most five times.
The shared throttle policy honors `Retry-After` seconds or dates, with a
one-second minimum and default wait, a 30-second cumulative wait budget, and
15 seconds reserved before the invocation deadline. A wait exceeding either
limit surfaces the 429 instead of retrying early. Throttle waits are logged.
This relies on the stream service rejecting a 429 before persisting the append.
Firewall challenges (`x-vercel-mitigated: challenge`) surface immediately.

Pre-connect failures (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, and
`UND_ERR_CONNECT_TIMEOUT`) can also retry because no append was sent, with
exponential backoff starting at 500 ms. Other transport failures surface without
replay because the outcome can be uncertain. HTTP errors other than 429 also
surface immediately.

Stream close is idempotent and has a separate retry policy, including selected
5xx responses. Custom dispatchers and `WORKFLOW_NODE_HTTP` bypass the SDK append
retry loop. Custom dispatchers must not replay append PUTs with consumed bodies.

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

HTTP requests (including the queue) default to shared undici dispatchers for connection pooling, with retry policies specific to each operation. Pass a custom `dispatcher` to override them, for example, to tune undici on newer Node.js runtimes:

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
