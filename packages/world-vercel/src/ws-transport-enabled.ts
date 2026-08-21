/**
 * The events-transport opt-in gate, deliberately alone in a module with no
 * imports. `events-v4.ts` and `queue.ts` read it on every invocation, so it has
 * to be answerable without pulling in `ws-transport.js` — and with it `ws`,
 * ~17 ms of module init that a deployment on the HTTP default never gets a
 * return on. Both call sites `await import('./ws-transport.js')` behind a true
 * result, so the cost lands only where the socket is actually used.
 */

/**
 * WS unless `WORKFLOW_EVENTS_TRANSPORT=http`. Only `createWorkflowRunEventV4`
 * (POST) is wired to it — GET/LIST aren't on the hot per-step path, and LIST's
 * streamed, sentinel-terminated multi-frame response doesn't map onto a single
 * WS message.
 *
 * The prerequisite this file used to name for defaulting on — that a WS write
 * open no client span — is met: `postEventFrameOverWs` opens one per frame,
 * carrying `workflow.events.transport: 'ws'`, `network.protocol.name` and the
 * `workflow.events.ws.req_id` that joins it to the server's log line. What
 * remains absent is Vercel's *outgoing requests* view, which is built by
 * instrumenting the global `fetch` rather than by reading spans, and which a
 * transport whose purpose is to issue no request cannot appear in.
 *
 * The comparison is only exactly `'http'`, not "anything that isn't `'ws'`", so
 * a typo'd or empty value fails toward the default rather than silently pinning
 * a deployment to the old transport — the failure mode this whole path is prone
 * to is being quietly off while looking fine.
 */
export function isWsEventsTransportEnabled(): boolean {
  return process.env.WORKFLOW_EVENTS_TRANSPORT !== 'http';
}
