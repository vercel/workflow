---
'@workflow/world-vercel': minor
'@workflow/builders': patch
'@workflow/rollup': patch
'@workflow/next': patch
---

Add an opt-in WebSocket transport for event writes during step execution (`WORKFLOW_EVENTS_TRANSPORT=ws`), as an alternative to the existing HTTP path. Defaults to HTTP; no behavior change unless explicitly enabled.

The `ws` package is loaded lazily, on the first connect, so a deployment that never enables the transport never evaluates it.

The transport resolves the auth token once per socket rather than once per event, reconnects eagerly (bounded backoff) after an unexpected close, releases its socket after an idle period so a warm container doesn't hold one open per run it has ever served, and fails a write closed rather than reporting success when a reply can't be understood. A reply that can't be correlated to a caller — undecodable, the server's malformed-frame sentinel, a non-numeric `reqId` — and a request that passes `WORKFLOW_REQUEST_TIMEOUT_MS` with no reply both fail their connection, so the waiter learns about it instead of hanging to the invocation's `maxDuration`.

Transport failures surface as a `WorkflowWorldError` with `code: 'TRANSPORT'` — the same shape a failed `fetch` produces — so the existing event-write retry policy covers both transports with no WebSocket-specific branch, retrying only the event types that are idempotent-on-retry and leaving the rest at a single attempt. A `drain` frame carrying `reason: 'auth_expiry'` forces a fresh token on the reconnect instead of replaying the one that just expired.

Known gap: unlike the HTTP path, WS event writes do not go through `instrumentedFetch`, so they open no OTEL client span, propagate no trace context, and do not appear in Vercel's outgoing-requests view. Instrumenting the transport is a prerequisite for making `ws` the default.

Also marks `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) external across the supported bundlers, so `ws` falls back to its pure-JS implementation instead of breaking the build. Neither package is installed by default, and each bundler fails differently: Rollup/Vite/Nitro fail the build outright on the unresolvable `require`, while webpack bundles the JS wrapper without its native binding and throws at runtime. The webpack side is handled in `@workflow/next`; the Rollup side is handled in `@workflow/rollup`'s `workflowTransformPlugin`, which `@workflow/nitro`, `@workflow/nuxt`, `@workflow/sveltekit` and `@workflow/astro` all already install — so this no longer requires per-app bundler config.
