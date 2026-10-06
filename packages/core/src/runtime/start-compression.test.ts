import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peekFormatPrefix } from '../serialization/format.js';
import { SerializationFormat } from '../serialization/types.js';
import { DYNAMIC_WORKFLOWS_ENV } from './constants.js';
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
    eventsCreate = vi.fn().mockImplementation((runId, event) =>
      Promise.resolve({
        run: {
          runId: runId ?? 'wrun_x',
          status: 'pending',
          // Echo the code back: start() refuses dynamic runs otherwise.
          dynamicWorkflowCode: event.eventData.dynamicWorkflowCode,
        },
      })
    );
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
      capabilities: { dynamicWorkflowCode: true },
      events: { create: eventsCreate },
      runs: { get: vi.fn() },
      queue: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const wf = Object.assign(() => Promise.resolve('ok'), {
    workflowId: 'test-workflow',
  });

  // Large and repetitive, so the default path compresses it.
  const args = [{ text: 'lorem ipsum dolor sit amet '.repeat(2000) }];

  function eventData(): Record<string, Uint8Array> {
    return eventsCreate.mock.calls[0]?.[1]?.eventData;
  }

  it('compresses arguments by default', async () => {
    await start(wf, args);
    expect(peekFormatPrefix(eventData().input)).toBe(SerializationFormat.ZSTD);
  });

  it('treats compression: true as the default', async () => {
    await start(wf, args, { compression: true });
    expect(peekFormatPrefix(eventData().input)).toBe(SerializationFormat.ZSTD);
  });

  it('stores arguments uncompressed with compression: false', async () => {
    await start(wf, args, { compression: false });
    expect(peekFormatPrefix(eventData().input)).toBe(
      SerializationFormat.DEVALUE_V1
    );
  });

  it('keeps compressing dynamic workflow code with compression: false', async () => {
    vi.stubEnv(DYNAMIC_WORKFLOWS_ENV, '1');
    // Past COMPRESSION_MIN_BYTES and repetitive, so the code compresses.
    const source = `async function workflow() {
  "use workflow";
  ${'// padding so the serialized source is worth compressing\n  '.repeat(40)}
  return 1;
}`;
    await start(source, args, {
      compression: false,
      experimental_dynamic: {
        steps: { noop: { stepId: 'step//./test//noop' } },
      },
    });
    const { input, dynamicWorkflowCode } = eventData();
    expect(peekFormatPrefix(input)).toBe(SerializationFormat.DEVALUE_V1);
    expect(peekFormatPrefix(dynamicWorkflowCode)).toBe(
      SerializationFormat.ZSTD
    );
  });
});
