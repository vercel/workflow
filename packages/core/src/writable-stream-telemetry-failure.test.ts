import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from './logger.js';
import { setWorld } from './runtime/world.js';
import { WorkflowServerWritableStream } from './serialization.js';

// The stream spans are recorded fire-and-forget. Make recording fail the way
// a broken OpenTelemetry setup (or an incomplete test mock) would.
vi.mock('./telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telemetry.js')>()),
  recordElapsedSpan: vi.fn().mockRejectedValue(new Error('tracer exploded')),
}));

describe('WorkflowServerWritableStream when recording a span fails', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        write: vi.fn().mockResolvedValue(undefined),
        writeMulti: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
    } as any);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    setWorld(undefined);
    vi.restoreAllMocks();
  });

  it('still writes and closes, and logs the failures instead of rejecting unhandled', async () => {
    const debug = vi.spyOn(runtimeLogger, 'debug');
    const stream = new WorkflowServerWritableStream('run-123', 'test-stream');
    const writer = stream.getWriter();

    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();
    // Let the fire-and-forget span promises settle, then any unhandled
    // rejection surface.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unhandled).toEqual([]);
    for (const span of ['workflow.stream.flush', 'workflow.stream.close']) {
      expect(debug).toHaveBeenCalledWith(
        'Failed to record a stream telemetry span',
        { span, error: 'tracer exploded' }
      );
    }
  });
});
