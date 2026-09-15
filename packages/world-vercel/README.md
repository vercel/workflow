# @workflow/world-vercel

Production workflow backend for Vercel platform deployments.

Integrates with Vercel's infrastructure for storage, queuing, and authentication. Handles workflow persistence and scaling in production environments.

Used by default for deployments on Vercel. Authentication and API endpoints are configured automatically in Vercel deployments.

Queue callbacks allow generic handler return values. Scheduling control is
interpreted only for ordinary queue messages, never for invocation-mode result
data.

## Experimental direct invocation

Set `WORKFLOW_VERCEL_INVOKE_URL` to the **full workflow execution endpoint URL** on
both producers and receivers, or pass `invoke: { endpoint }` to `createWorld()`.
The default is disabled; disabled Worlds do not expose `invoke`.

```ts
const world = createWorld({
  invoke: {
    endpoint: 'https://example.vercel.app/.well-known/workflow/v1/flow',
  },
});
```

The configured endpoint must already support platform affinity and deployment
selection. This setting does not provision affinity-enabled compute. Requests set
`x-vercel-affinity-id` to the first 16 bytes of SHA-256(runId), hex encoded, and
`x-deployment-id` to the run's pinned deployment. The latter uses Vercel Skew
Protection routing and is subject to its enablement/retention limits. The receiver
rejects wrong-deployment delivery before processing. For custom routing,
`endpoint` may be an async function of `{ runId, deploymentId, region }`.
`region` describes the run's data/queue region, not necessarily the function's
compute region. Select an endpoint whose placement is consistent with ordinary
workflow execution.

Invocation is a single direct CBOR POST, not a VQS send or result-polling loop.
The receiver authenticates same-project/environment workload OIDC, places input
in a private per-run RAM mailbox, and waits for its SDK handler result. The
sender obtains OIDC through `@vercel/oidc`, or `invoke.getToken()`. An ordinary
Vercel API token in `config.token` does not authorize this ingress. No new public
mailbox/respond interface is exposed. Typed errors use the shared invocation
outcome codec. Existing queue callbacks still use their VQS transport; eligible
orchestration sends also get the same affinity key, and enabled receivers check
it. Steps and health checks retain their normal parallel path.

The mailbox has separate input and execution lanes, allowing a hook while an
inline step awaits it. Cold input starts a local continuation; a revision check
covers inputs arriving while execution exits. Continuations are registered with
Vercel `waitUntil`, within the function's lifetime, and retain normal step/timer
scheduling. Caller context is preserved for each queued input. Limits per handler:
64 live run states, 32 pending inputs per run, 128 pending inputs total. Full
mailboxes reject with 429. Completed idle states are released.

`invoke` waits up to 30 seconds by default (`timeoutMs`: 1–120,000 ms). Request and
response bodies are limited to 1 MiB each. Timeout/disconnect does not roll back
processing; retry the same logical input with its original idempotency key and
payload. The adapter does not retry POST automatically. A custom `dispatcher`
must preserve that policy. Instance loss discards unprocessed RAM, and a lost
response after commit is an unknown outcome. Fresh backend hook dedup attestation
is required for new hook writes; matching disposed-hook retries use durable data.

Deploy matching protocol versions and enable this only on verified affinity
endpoints. This is the hook/mailbox increment toward single-writer execution;
other mutation paths and existing consistency checks remain. It adds neither
durable input storage nor stale-writer fencing. Local tests do not prove live
platform placement or deployment migration behavior.
An accepted input does not guarantee that a later continuation succeeds. A
continuation failure is logged; after process loss or failure beyond the response,
progress depends on existing runtime recovery or another execution request.

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
