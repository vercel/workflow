import { afterEach, describe, expect, it } from 'vitest';
import * as first from './ws-transport.js';
// A second, independent instance of the same module. Vite keys its module
// registry on the specifier, so the query suffix buys what a bundler layer
// buys in a Next.js server build: the same file, compiled and evaluated twice
// in one process.
// @ts-expect-error -- same module, distinct instance; no declaration for the query form
import * as second from './ws-transport.js?copy=2';

const WS_URL = 'wss://vercel-workflow.test/websockets/v1/runs/wrun_copies';
const headers = async () => ({ authorization: 'Bearer test' });

afterEach(() => {
  first.resetWsEventsTransportsForTest();
});

describe('ws transport registry across module copies', () => {
  /**
   * Guards the test against becoming vacuous: if the two specifiers ever
   * collapsed to one module instance, every assertion below would pass for the
   * wrong reason. Class identity is module-scope state, so distinct classes
   * means distinct instances, and is itself the thing that used to make the
   * registry diverge.
   */
  it('imports two genuinely distinct instances of the module', () => {
    expect(second.WsTransportError).not.toBe(first.WsTransportError);
  });

  /**
   * The vercel/workflow#3493 regression, in miniature. `@workflow/world-vercel`
   * became bundled rather than external, so one process holds one copy of this
   * module per bundler layer. The queue consumer opened its channel from the
   * `instrument` copy and the events write path looked it up from the route
   * copy's own, empty `Map`. Every event then silently fell back to HTTP for
   * the life of the process.
   */
  it('finds a transport registered by the other copy', () => {
    const registered = first.getWsEventsTransport(WS_URL, headers);
    expect(second.getWsEventsTransport(WS_URL, headers)).toBe(registered);
  });

  it('drops it for both copies when either one resets', () => {
    const registered = first.getWsEventsTransport(WS_URL, headers);
    second.resetWsEventsTransportsForTest();
    expect(first.getWsEventsTransport(WS_URL, headers)).not.toBe(registered);
  });
});
