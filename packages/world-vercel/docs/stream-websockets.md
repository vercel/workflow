# WebSockets for stream data in world-vercel

Status of the `getWritable()` / `getReadable()` stream transports in
`@workflow/world-vercel`, as of `main` at `a6c455a09c` (2026-10-02). This is a
tracking document, not user documentation; the user-facing reference for the
environment variables below lives in
`docs/content/worlds/v5/vercel.mdx` and `docs/content/docs/v5/configuration/worlds.mdx`.

The WebSocket **events** transport (`WORKFLOW_EVENTS_TRANSPORT`, step and run
event writes) is a separate transport and out of scope here.

## Current state

### Writes

Core gives every in-memory writable sink one stable identity and sequence
space (`packages/core/src/serialization.ts`): a `writerId` (`wrtr_<ulid>`) and
a writer-local `chunkSeq`. It asks the World for an optional
`streams.createWriteSession(runId, name, { writerId })`. Worlds that don't
implement it keep using `write` / `writeMulti` / `close`. Group-commit
buffering is unchanged: `write()` resolves when the chunk enters the bounded
buffer, and each accumulated group goes out as one write.

world-vercel implements the session in `ws-stream-session.ts` using the
`workflow-stream-ws/v1` protocol (`stream-ws-protocol-v1.ts`, golden fixture in
`src/__fixtures__/workflow-stream-ws-v1.json`):

| Aspect | Behavior on `main` |
|---|---|
| Opt-in | Client: `WORKFLOW_STREAMS_TRANSPORT=ws`, exact match. Default is HTTP. The backend accepts upgrades by default and can decline any of them. |
| Connection | One socket per writer lifetime. No socket for a stream that only ever writes one group. |
| First write | Goes over HTTP. The socket upgrade starts in the background when the second HTTP group is dispatched, and the writer switches transports at a confirmed request boundary. |
| Fallback | A decline or failure before the upgrade completes keeps the writer on HTTP for its lifetime. |
| Ordering | Requests are serialized: one write or close in flight per writer. No pipelining. |
| Message size | Groups split by bytes into ordered requests, bounded by `WORKFLOW_WS_MAX_MESSAGE_BYTES` (default 12 MiB, clamped 2-16 MiB). A single chunk too large for any message is sent over HTTP. |
| 429 | A correlated 429 means the write did not apply. The session waits out `Retry-After` and resends on the same socket, then moves to HTTP once the shared 30s throttle budget is spent. |
| Idle close | A clean idle close reconnects with the same `writerId`, at most 3 times. |
| Unknown outcome | A write sent without a correlated reply **poisons the writer**: the write fails and is not replayed over HTTP or another socket. An HTTP write with an unknown outcome also poisons it. |
| Telemetry | `workflow.stream.ws.connect` span for the handshake; one synthesized `http POST` span per frame; phase timings on the first write of each session and each reconnect. |

`writerId` and `chunkSeq` are **observational** in v1: the backend uses them to
make writer interleaving visible, not to fence or deduplicate writes.

### HTTP writes (the default path)

`streamer.ts` writes groups with multi-chunk `PUT`s through a dedicated H2
agent (`STREAM_AGENT_OPTIONS`: `allowH2: true`, `pipelining: 1`,
`connections: 8`) with no whole-request deadline. Appends retry only on 429
(`STREAM_RETRY_OPTIONS`), because a resend after an ambiguous failure can
duplicate chunks. Close is idempotent and also retries 5xx.

### Reads

Reads are HTTP only: a long-lived live read (`GET`, v3) through core's
reconnecting framed reader, plus snapshot reads. There is no WebSocket read
path on `main`.

## Gaps

1. **An append with an unknown outcome is fatal on both transports.** Neither
   path deduplicates, so a write whose acknowledgement never arrives (timeout,
   reset, half-open socket) cannot be retried safely and fails the stream, and
   with it the step or run. This is the failure reported in production on
   #2731: 4 of 108 concurrent streaming runs failed on a single stalled
   append, and 1 of 108 still failed after client-side transport mitigations.
   Closing it requires backend deduplication keyed by `(writerId, chunkSeq)`
   plus a client that replays unacknowledged writes, which in turn makes
   reconnect and HTTP fallback lossless instead of poisoning.
2. **WebSocket writes are off by default on the client.** Rollout needs
   `WORKFLOW_STREAMS_TRANSPORT=ws` per project. There is no client-side
   default flip or per-workflow override (the events transport has both).
3. **No write pipelining.** One request in flight per writer, so throughput on
   a single high-volume stream is bounded by one round trip per group. Safe
   pipelining depends on gap 1, because more requests in flight means more of
   them have an unknown outcome when a socket drops.
4. **No WebSocket reads.** Live reads still pay HTTP reconnects and
   resume-offset bookkeeping in core.
5. **HTTP write transport hardening** suggested on #2731 is not adopted:
   HTTP/1.1 for the stream write/close agents (undici keeps routing appends
   onto an H2 session whose stream timed out), per-request
   `headersTimeout` / `bodyTimeout` armed only once a connection is held, and a
   larger stream pool than 8 connections shared by every streaming run on an
   instance. These reduce how often gap 1 triggers; they do not remove it.
6. **Backpressure under a full backlog.** A write that finds the backend's
   unpersisted backlog full gets a 429. The WebSocket path then falls back to
   HTTP after the throttle budget, and HTTP gives up after its retries, so a
   sustained high-rate stream can fail before the backlog drains.
7. **No read-after-write barrier for users.** Durability is only observable by
   closing the stream.

## PRs

### Merged (current state)

| PR | Change |
|---|---|
| #2995 | Batch stream writes through `writeMulti` |
| #3078 | Path-independent group commit in the server writable |
| #3763 | `workflow-stream-ws/v1` client protocol contract |
| #3764 | `WORKFLOW_STREAMS_TRANSPORT=ws` capability gate |
| #3832 | `createWriteSession` seam: per-writer `writerId` and sequence |
| #3833 | WebSocket writer lifecycle, HTTP fallback, poisoning |
| #4074 | First-write phase tracing |
| #4076 | First write does not block on the WebSocket handshake |
| #4104 | Background takeover after the first HTTP write |
| #4381 | Retry throttled (429) WebSocket writes |
| #4510 | Bound WebSocket write messages by bytes |

### Closed, to revisit

| PR | Relevant to | What it had |
|---|---|---|
| #2731 | Gaps 1, 3 | framed-v2 frames with per-writer markers, acked write channel, replay of unacknowledged frames across reconnects, FIN/FIN_ACK close, lossless circuit-break to `PUT`. Superseded on transport by the v1 stack above; its dedupe and replay design is the starting point for gap 1. |
| #3359 | Gaps 1, 4 | Prototype combined read/write WebSocket transport with explicit `stream_end.reason` |
| #3862, #3863, #3864 | Gap 4 | `workflow-stream-read-ws/v1` protocol, credit-driven read session with absolute-index resume, `streams.getResumable` |
| #3890 | Gap 3 | Bounded write pipelining (depth up to 4) with sequence reservation; fail-stop on any unknown outcome |

### Open

| PR | Relevant to |
|---|---|
| #3934 | Gap 7: `WorkflowWritableStream.flush()` |
| #4178 | Gated stream write/read attribution diagnostics |
| #4298 | E2E coverage for cross-region stream writes |
| #3662 | Benchmark transport and server-URL overrides |

### New PRs needed

1. **`workflow-stream-ws/v2` with deduplication (gap 1).** Backend fences
   `(writerId, chunkSeq)` and acknowledges duplicates as applied. Client
   replays unacknowledged writes on reconnect and on HTTP fallback instead of
   poisoning. The HTTP `PUT` path needs the same `writerId` / `chunkSeq`
   headers so an ambiguous append can be retried there too. Requires a
   backend change shipped first, and a capability negotiation so older
   backends keep v1 behavior.
2. **Stream HTTP transport hardening (gap 5).** Port the mitigations from the
   #2731 report, measured against the same concurrent-burst shape.
3. **Client default to WebSocket writes (gap 2)**, after gap 1 lands, with a
   per-workflow override matching the events transport.
4. **Pipelining (gap 3)**, rebased from #3890 onto v2 dedupe so a dropped socket
   replays instead of failing.
5. **WebSocket reads (gap 4)**, revived from #3862-#3864 if read-side
   reconnect cost shows up in measurements.
6. **Backlog backpressure (gap 6).** Hold or slow the writer while the backend
   drains instead of failing it after a fixed retry budget; needs a
   matching backend change.
