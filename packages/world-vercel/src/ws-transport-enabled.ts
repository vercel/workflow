/**
 * The events-transport opt-in gate, deliberately alone in a module with no
 * imports. `events-v4.ts` and `queue.ts` read it on every invocation, so it has
 * to be answerable without pulling in `ws-transport.js` and with it `ws`,
 * ~17 ms of module init that a deployment on the HTTP default never gets a
 * return on. Both call sites `await import('./ws-transport.js')` behind a true
 * result, so the cost lands only where the socket is actually used.
 */

/**
 * HTTP unless `WORKFLOW_EVENTS_TRANSPORT=ws`. Only `createWorkflowRunEventV4`
 * (POST) is wired to it. GET/LIST aren't on the hot per-step path, and LIST's
 * streamed, sentinel-terminated multi-frame response doesn't map onto a single
 * WS message.
 *
 * A WS write still opens a client span: `postEventFrameOverWs` opens one per
 * frame, carrying `workflow.events.transport: 'ws'`, `network.protocol.name`
 * and the `workflow.events.ws.req_id` that joins it to the server's log line.
 * What remains absent is Vercel's *outgoing requests* view, which is built by
 * instrumenting the global `fetch` rather than by reading spans, and which a
 * transport whose purpose is to issue no request cannot appear in.
 *
 * `ws` is the only value that opts in. Anything else — unset, empty, `http`,
 * or an unrecognized value — stays on HTTP, so a typo fails toward the
 * default rather than enabling a transport nobody asked for. The opt-in is
 * matched case-insensitively and trimmed, so `WS` typed into a dashboard field
 * is not silently ignored.
 */
export function isWsEventsTransportEnabled(): boolean {
  return process.env.WORKFLOW_EVENTS_TRANSPORT?.trim().toLowerCase() === 'ws';
}

/**
 * Whether a WS fallback that should not happen must fail loudly instead of
 * quietly writing over HTTP. Internal, undocumented, and meant for the WS e2e
 * lane, which otherwise passes whether or not the socket carried anything.
 *
 * Like the gate above, an unrecognized value means *off*: this turns a silent
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
 * HTTP is the compatibility path and the default. Unlike the events gate
 * above, this opt-in is exact-match (case-sensitive, untrimmed): a typo must
 * fail toward HTTP rather than unexpectedly enabling an experimental
 * transport. This deliberately has no package-version or tenant-policy
 * heuristic; rollout policy belongs to the
 * server. v1 is `/websockets/v1`, independently versioned from REST v2/v4 and
 * persisted workflow spec versions.
 */
export function isWsStreamsTransportEnabled(): boolean {
  return process.env.WORKFLOW_STREAMS_TRANSPORT === 'ws';
}
