/**
 * The events-transport opt-in gate, deliberately alone in a module with no
 * imports. `events-v4.ts` and `queue.ts` read it on every invocation, so it has
 * to be answerable without pulling in `ws-transport.js` — and with it `ws`,
 * ~17 ms of module init that a deployment on the HTTP default never gets a
 * return on. Both call sites `await import('./ws-transport.js')` behind a true
 * result, so the cost lands only where the socket is actually used.
 */

/**
 * HTTP unless `WORKFLOW_EVENTS_TRANSPORT=ws`. Only `createWorkflowRunEventV4`
 * (POST) is wired to it — GET/LIST aren't on the hot per-step path, and LIST's
 * streamed, sentinel-terminated multi-frame response doesn't map onto a single
 * WS message.
 *
 * The socket carries the same frames to the same route as the HTTP branch. Its
 * endpoint is versioned on its own (`/websockets/v1`, see `toEventsWsUrl`), and
 * each frame is forwarded into the newest events route — the one
 * `EVENTS_ROUTE_VERSION` in `events-v4.ts` names for the HTTP branch. Which
 * route is not a thing the client picks per transport, and should not become
 * one: a run may write over either and must get the same semantics from both.
 *
 * **Known gap: WS writes open no client span.** The upgrade carries W3C trace
 * context (see `resolveUpgradeHeaders`), so server spans still join the caller's
 * trace, but the HTTP branch's `instrumentedFetch` also opens an OTEL CLIENT
 * span per write and routes through the global `fetch` that Vercel's
 * outgoing-requests view instruments; the WS branch has neither, and individual
 * frames carry no `traceparent` of their own. Acceptable behind a flag —
 * per-write instrumentation is a prerequisite for defaulting to it.
 */
export function isWsEventsTransportEnabled(): boolean {
  return process.env.WORKFLOW_EVENTS_TRANSPORT === 'ws';
}
