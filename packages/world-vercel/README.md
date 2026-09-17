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
  invoke: { endpoint: 'https://example.vercel.app/.well-known/workflow/v1/invoke' },
});
```

The Next.js integration generates `/.well-known/workflow/v1/invoke` as an HTTP
entry point without a queue trigger. Other integrations must provide an HTTP
entry point using their workflow execution handler. The receiver authenticates
direct requests before processing inputs.
Reusing handler code does not guarantee that the HTTP and queue routes share a
running process.

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
execution still uses VQS. Ordinary startup and wake callbacks may have no affinity
header; they are logged and continue executing. Steps and health checks retain
their parallel delivery path.

Affinity selectors are diagnostic observations on both paths. Missing or different
selectors do not reject a workflow. Direct hook requests still send the run's
affinity key, and authentication and actual pinned-deployment checks remain.
Structured `workflow-invocation` records include invocation/request/message IDs,
process identity, region, observed selectors, outcome, and elapsed time. They omit
credentials and input/result payloads. Header equality is not a placement guarantee.

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

## Retained runner (opt-in)

Set `WORKFLOW_RETAINED_RUNNER=1` alongside the direct invocation configuration
for new, same-deployment runs using the Node VM. This mode requires the World
to provide exclusive per-run delivery. The header is a routing mechanism;
the runtime does not add a distributed ownership protocol.

The owner loads committed history once and retains the VM across hook inputs.
It keeps hook and idempotency state locally. One mailbox loop serializes input
processing and event commits, including writes from asynchronous step workers.
Step bodies currently run in the owning process; the mailbox remains available
while they await I/O. Queue wakes enter through the direct endpoint instead of
starting a second execution path.

An input's `hook_received` event is committed before it is fed to the retained
VM. Follow-up events emitted by the VM must also commit before the input is
acknowledged. The idle wait is 60 seconds, bounded by the host deadline; the
caller does not wait for that idle interval. After retirement, the next owner
reconstructs its state from committed history.

Write acknowledgements may contain lazy payload references instead of echoed
bytes. After validating the committed identity and position, the owner uses its
already-known submitted bytes to construct the local event and payload-bearing
entity state. It does not read its own payload back. Resolved payload mismatches
and conflicting acknowledgement metadata remain fatal; diagnostics identify the
failed check.

Unexpected returned events or persistence failures stop the owner. It attempts
to persist `run_failed` and rejects unfinished inputs. No event-write retries or
conflict reconciliation are performed in this mode. If the terminal failure
cannot be persisted, the failure observation explicitly reports that fact.

The optional `workflow.runner` Node diagnostics channel reports mailbox turns,
persistence, step execution, and terminal-failure recording. Messages include
owner/span identities and timing, not workflow payloads. `workflow.execution`
reports replay versus retained VM passes. Older pinned runs retain their prior
execution model; new runs carry `executionContext.retainedRunnerVersion: 1`.

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
