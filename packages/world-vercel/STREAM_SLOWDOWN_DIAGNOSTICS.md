# Temporary stream slowdown diagnostic

`WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS=true` enables a temporary client-side
attribution log only when all fail-closed gates match: `VERCEL_ENV=preview`,
`VERCEL_PROJECT_ID=prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm`, a canonical `wrun_` ULID,
and the same ULID in the exact `strm_<ulid>_user_YmVuY2gtY3R0` (`bench-ctt`)
stream ID. Writes additionally require a canonical `wrtr_` ULID. Headers and
payloads cannot enable the diagnostic.

Each JSON line has schema version `v`, diagnostic/lane/kind, run/stream/session
continuity fields, `clock: "performance.now"`, `timeOrigin`, first/last tuple
sequence, numeric tuples, and attempted/emitted/omitted/sink-failure counters.
Tuple shape is `[sequence, timestampMs, phase, a?, b?, c?, d?]`; phase defines
the numeric positions. IDs are correlation fields only and are never metric
tags. No payload, authorization, headers, secrets, stack, or error text is
recorded.

Write phases cover core group dispatch/settle, session entry/return, encoding,
`ws.send` call/return/callback, raw reply/decode/resolve, connection attempts,
fallback, poison, and teardown. Numeric write values carry group ordinal,
request ID, writer-local chunk range/count/bytes, and connection attempt where
available. Read phases distinguish the first non-empty **raw response-body
chunk** (transport bytes, possibly a partial frame) from the first complete
outer frame and decoded delivery, then deserialization and consumer enqueue.
These are same-process monotonic timestamps; compare tuples only when their
`timeOrigin` matches. They do not measure server work or cross-process clock
time, and enqueue is not proof that user code has run.

Read and write lanes are independently capped at 192 attempted tuples per
session. Lines carry at most 64 tuples and are refused above 16 KiB. Teardown
reports omissions and sink failures. Logging is best effort and throwing sinks
are swallowed. Instrumentation does not add operational awaits, change promise
ownership, inspect frame payloads, or alter timeout/reconnect/fallback policy.
