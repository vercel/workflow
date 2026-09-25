import { channel } from 'node:diagnostics_channel';
import { afterEach, expect, it, vi } from 'vitest';
import { createEventWriteSession } from './event-write-session.js';

const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('./ws-transport-enabled.js', () => ({
  isWsEventsTransportEnabled: () => true,
}));
vi.mock('./ws-transport.js', () => ({
  openWsChannel: mocks.open,
  resolveWsTransport: () => ({ transport: { close: mocks.close } }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  false,
  true,
])('observes channel readiness separately from writes (failure=%s)', async (failure) => {
  vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'eventsync');
  const ready = Promise.withResolvers<void>();
  const release = Object.assign(vi.fn(), {
    ready: () => ready.promise,
    flushThrough: vi.fn(),
  });
  mocks.open.mockReturnValue(release);
  const records: Record<string, unknown>[] = [];
  const receive = (event: unknown) =>
    records.push(event as Record<string, unknown>);
  const observations = channel('workflow.eventsync');
  observations.subscribe(receive);
  try {
    const writer = createEventWriteSession('wrun_ready');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(records.map((e) => e.event)).toEqual(['begin']);
    // Disposal must not be blocked by an uncompleted handshake.
    await writer.dispose();
    expect(release).toHaveBeenCalledOnce();
    if (failure) ready.reject(new Error('upgrade failed'));
    else ready.resolve();
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toMatchObject({
      spanId: records[0].spanId,
      phase: 'writer_ready',
      event: 'end',
      status: failure ? 'error' : 'completed',
    });
  } finally {
    observations.unsubscribe(receive);
  }
});
