---
'@workflow/world-vercel': minor
'@workflow/next': patch
---

Add an opt-in WebSocket transport for event writes during step execution (`WORKFLOW_EVENTS_TRANSPORT=ws`), as an alternative to the existing HTTP path. Defaults to HTTP; no behavior change unless explicitly enabled.

The `ws` package is loaded lazily, on the first connect, so a deployment that never enables the transport never evaluates it.

The transport resolves the auth token once per socket rather than once per event, reconnects eagerly (bounded backoff) after an unexpected close, releases its socket after an idle period so a warm container doesn't hold one open per run it has ever served, and fails a write closed rather than reporting success when a reply can't be understood. Transient failures — `500`/`502`/`503`/`504` and dropped connections — are retried in-process under the same policy the HTTP path gets from undici's `RetryAgent`, `Retry-After` included, with `429` deliberately passed through so a firewall challenge reaches the queue. A `drain` frame carrying `reason: 'auth_expiry'` forces a fresh token on the reconnect instead of replaying the one that just expired.

Known gap: unlike the HTTP path, WS event writes do not go through `instrumentedFetch`, so they open no OTEL client span, propagate no trace context, and do not appear in Vercel's outgoing-requests view. Instrumenting the transport is a prerequisite for making `ws` the default.

Also externalizes `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) in webpack builds so `ws` still bundles and falls back to its pure-JS implementation when those packages aren't installed.
