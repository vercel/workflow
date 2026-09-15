# Temporary stream slowdown diagnostic

This diagnostic is a disposable draft PR artifact for PR #4178 and is not
intended to merge to `main`. It has no runtime toggle. The temporary client-side
attribution log activates automatically only when all fail-closed gates match:
`VERCEL_ENV=preview`,
`VERCEL_PROJECT_ID=prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm`, a canonical `wrun_` ULID,
and the same ULID in the exact `strm_<ulid>_user_YmVuY2gtY3R0` (`bench-ctt`)
stream ID. Writes additionally require a canonical `wrtr_` ULID. Headers and
payloads cannot enable the diagnostic.

Each JSON line has schema version `v: 3`, diagnostic/lane/kind, run/stream/session
continuity, `clock: "performance.now"`, `timeOrigin`, exact attempted/emitted/
omitted group/chunk/byte counters, overflow and sink-failure counters. No
payload, authorization, headers, secrets, stack, or error text is recorded.
Offsets are comparable only within a session with the same `timeOrigin`; they do
not measure server work or cross-process time.

## Write schema

`writeTupleSchema: "completed-group-v1"` identifies one tuple per terminal
successful or rejected core group:

```text
[groupOrdinal, reqId|null, chunkSeq, chunkCount, chunkBytes,
 connectionGeneration|null, connectionAttempt|null,
 outcome,
 coreDispatch, sessionEntry, encodeBegin, encodeEnd,
 wsSendCall, wsSendReturn, wsSendCallback, rawMessageCallback,
 decodeComplete, pendingResolve, sessionReturn, coreSettle]
```

The twelve phases are same-clock offsets from `coreDispatch`. A `null` means the
phase did not occur or was not observable at an existing seam; it is never a
fabricated timestamp. Initial HTTP bootstrap/control and HTTP fallback groups
therefore have no `reqId` or WS phases. Rejected groups retain the phases that
actually occurred. Connection generation and attempt currently advance together
because each accepted socket generation is created by one numbered connection
attempt.

Completed groups are accumulated in fixed per-live-group/request state, deleted
at settle/reject, and emitted 48 per envelope under 16 KiB. The normal reserve
holds 2,720 completed groups (headroom over the 2,593-event canonical cadence)
and uses at most 72 batch lines. A separate 192-record incident reserve and a
terminal envelope survive normal-budget exhaustion. The terminal envelope
reports live-map sizes and all continuity counters. At most eight groups and two
requests may be live, and at most 64 logical diagnostic sessions may exist
process-wide. New sessions fail closed rather than evicting live continuity.

## Read schema and selection

Reads do **not** emit per-chunk phase triplets. `readConnections` retains one
compact setup tuple/object per connection: core dispatch, world entry, fetch
call, headers, first non-empty raw body bytes, first complete outer frame, start
index/reconnect ordinal, HTTP status, byte counts, and setup outcome where
observed. `readAggregate` reports complete decoded and consumer-enqueued counts
and bytes plus bounded latency aggregates. Progress/slow/fallback/error facts use
the separate bounded incident reserve.

Per-chunk coverage is intentionally supplied by the complete CTT and server
reader ranges. The client selection answers setup/reconnect attribution and
verifies aggregate continuity without logging 2,593 nearly identical decode and
enqueue tuples. `latencySamples` counts decoded-delivery/consumer-enqueue pairs;
`latencyOmitted` explicitly counts deliveries whose timestamp was superseded
when one raw pull decoded multiple frames before downstream enqueue. Their sum
makes latency coverage self-describing while counts and bytes remain complete.
Enqueue means the downstream stream accepted the value, not that user code ran.

All handles in core and world-vercel for one run/stream/lane share the
process-global aggregation and terminal ownership, including reconnect GETs.
Terminal completion/cancel/error frees its slot and clears live maps. Logging is
best effort and throwing sinks are swallowed. Instrumentation adds no operational
awaits or catches and does not change promise ownership, serialization,
callback ordering, timeout, read pull/backpressure/cancel, reconnect, fallback,
or error precedence. A raw WS arrival is assigned to a write only after decode
confirms its request ID; uncorrelated control-frame arrivals use the bounded
incident reserve instead.
