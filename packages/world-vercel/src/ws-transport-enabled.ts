/**
 * The events-transport opt-in gate, deliberately alone in a module with no
 * imports. `events-v4.ts` and `queue.ts` read it on every invocation, so it has
 * to be answerable without pulling in `ws-transport.js` and with it `ws`,
 * ~17 ms of module init that a deployment on the HTTP default never gets a
 * return on. Both call sites `await import('./ws-transport.js')` behind a true
 * result, so the cost lands only where the socket is actually used.
 */

/**
 * WS unless `WORKFLOW_EVENTS_TRANSPORT=http`. Only `createWorkflowRunEventV4`
 * (POST) is wired to it. GET/LIST aren't on the hot per-step path, and LIST's
 * streamed, sentinel-terminated multi-frame response doesn't map onto a single
 * WS message.
 *
 * This file used to name a prerequisite for defaulting on: that a WS write opens
 * no client span. That is met. `postEventFrameOverWs` opens one per frame,
 * carrying `workflow.events.transport: 'ws'`, `network.protocol.name` and the
 * `workflow.events.ws.req_id` that joins it to the server's log line. What
 * remains absent is Vercel's *outgoing requests* view, which is built by
 * instrumenting the global `fetch` rather than by reading spans, and which a
 * transport whose purpose is to issue no request cannot appear in.
 *
 * `http` is the only value that opts out, rather than "anything that isn't
 * `ws`". An unrecognized value takes the default instead of quietly pinning a
 * deployment to the old transport.
 *
 * That opt-out is matched case-insensitively and trimmed, which is the one
 * place this gate deliberately does *not* fail toward the default. Everything
 * else here is written on the assumption that being quietly on the wrong
 * transport is the failure mode to design against, and the reader most exposed
 * to it is whoever is reaching for the escape hatch: plausibly mid-incident,
 * plausibly typing `HTTP` into a dashboard field. Silently ignoring their
 * opt-out because of case is the same bug this default flip is trying to stop
 * shipping, pointed at the person least able to afford it.
 */
export function isWsEventsTransportEnabled(): boolean {
  return process.env.WORKFLOW_EVENTS_TRANSPORT?.trim().toLowerCase() !== 'http';
}

/**
 * Whether a WS fallback that should not happen must fail loudly instead of
 * quietly writing over HTTP. Internal, undocumented, and meant for the WS e2e
 * lane, which otherwise passes whether or not the socket carried anything.
 *
 * Note the asymmetry with the gate above, which is deliberate and the opposite
 * way round. There, an unrecognized value takes the default, because the risk
 * is a deployment quietly sitting on the wrong transport. Here an unrecognized
 * value means *off*, because the risk runs the other way: this turns a silent
 * degradation into a failed run, and nobody should acquire that by typo.
 */
export function isWsEventsTransportStrict(): boolean {
  const raw = process.env.WORKFLOW_INTERNAL_EVENTS_TRANSPORT_STRICT;
  return raw === '1' || raw === 'true';
}

/**
 * Advertise the experimental v1 stream-write protocol only when explicitly
 * requested. This is a client capability signal, not an entitlement: the
 * server authoritatively accepts or declines every upgrade, and a decline
 * falls back directly to the HTTP stream writer.
 *
 * HTTP is the compatibility path and the default. This deliberately has no
 * package-version or tenant-policy heuristic; rollout policy belongs to the
 * server. v1 is `/websockets/v1`, independently versioned from REST v2/v4 and
 * persisted workflow spec versions.
 */
export function isWsStreamsTransportEnabled(): boolean {
  return process.env.WORKFLOW_STREAMS_TRANSPORT === 'ws';
}

/** Read transport capability is independently default-off. */
export function isWsStreamReadsTransportEnabled(): boolean {
  return process.env.WORKFLOW_STREAM_READS_TRANSPORT === 'ws';
}

/** Experimental bounded write depth; invalid values fail closed to serial. */
export function getWsStreamWritePipelineDepth(): 1 | 2 | 4 {
  const raw = process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH;
  if (raw === '2') return 2;
  if (raw === '4') return 4;
  return 1;
}
