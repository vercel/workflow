/**
 * The `ws` package must not be evaluated unless the transport is actually
 * used.
 *
 * `events-v4.ts` imports `ws-transport.js` unconditionally — the
 * `WORKFLOW_EVENTS_TRANSPORT` gate is a runtime branch, not a build-time one
 * — so a static `import { WebSocket } from 'ws'` puts `ws` and its optional
 * native accelerators on the module-init path of every deployment, including
 * the overwhelming majority that never opt in and never open a socket.
 *
 * This lives in its own file on purpose. Vitest caches a `vi.mock` factory's
 * result for the lifetime of the module registry, so once any test in a file
 * has connected, the factory never runs again and the counter below can't
 * distinguish "loaded lazily" from "loaded at import". A file that connects
 * exactly once is the only way to observe it.
 */

import { describe, expect, it, vi } from 'vitest';

/** Incremented each time the `ws` module is evaluated. */
const wsModuleLoads = vi.hoisted(() => ({ count: 0 }));

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeSocket {
    readyState = 0;
    binaryType = '';
    constructor(
      readonly url: string,
      readonly options?: { headers?: Record<string, string> }
    ) {}
    on(): this {
      return this;
    }
    send(): void {}
    close(): void {}
  }
  return { FakeWebSocket: FakeSocket };
});

vi.mock('ws', () => {
  wsModuleLoads.count++;
  return { WebSocket: FakeWebSocket };
});

describe('lazy `ws` load', () => {
  it('does not evaluate `ws` until the first connect', async () => {
    const { getWsEventsTransport } = await import('./ws-transport.js');

    // Importing the transport — which is what every deployment does, opted
    // in or not — must not have pulled `ws` in.
    expect(wsModuleLoads.count).toBe(0);

    const transport = getWsEventsTransport(
      'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_lazy',
      async () => ({ authorization: 'Bearer token-1' })
    );
    void transport.request(() => new Uint8Array(0)).catch(() => {});

    // The dynamic import resolves over several microtask turns.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(wsModuleLoads.count).toBe(1);
  });
});
