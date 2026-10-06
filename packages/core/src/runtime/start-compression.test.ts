import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peekFormatPrefix } from '../serialization/format.js';
import { SerializationFormat } from '../serialization/types.js';
import { start } from './start.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
}));

describe('start() compression option', () => {
  let eventsCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventsCreate = vi.fn().mockImplementation((runId) =>
      Promise.resolve({
        run: { runId: runId ?? 'wrun_x', status: 'pending' },
      })
    );
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
      events: { create: eventsCreate },
      runs: { get: vi.fn() },
      queue: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  const wf = Object.assign(() => Promise.resolve('ok'), {
    workflowId: 'test-workflow',
  });

  // Large and repetitive, so the default path compresses it.
  const args = [{ text: 'lorem ipsum dolor sit amet '.repeat(2000) }];

  function storedInput(): Uint8Array {
    return eventsCreate.mock.calls[0]?.[1]?.eventData?.input;
  }

  it('compresses arguments by default', async () => {
    await start(wf, args);
    expect(peekFormatPrefix(storedInput())).toBe(SerializationFormat.ZSTD);
  });

  it('stores arguments uncompressed with compression: false', async () => {
    await start(wf, args, { compression: false });
    expect(peekFormatPrefix(storedInput())).toBe(
      SerializationFormat.DEVALUE_V1
    );
  });
});
