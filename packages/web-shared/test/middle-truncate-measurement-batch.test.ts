import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelMeasurement,
  scheduleMeasurement,
} from '../src/components/trace-viewer/components/middle-truncate/measurement-batch.js';

function mockAnimationFrames(): {
  cancel: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  runNext: () => void;
} {
  let nextFrame = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback): number => {
    const frame = nextFrame++;
    callbacks.set(frame, callback);
    return frame;
  });
  const cancel = vi.fn((frame: number): void => {
    callbacks.delete(frame);
  });

  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);

  return {
    cancel,
    request,
    runNext: () => {
      const next = callbacks.entries().next().value;
      if (!next) {
        throw new Error('No animation frame is scheduled');
      }

      const [frame, callback] = next;
      callbacks.delete(frame);
      callback(0);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MiddleTruncate measurement batching', () => {
  it('runs every DOM read before any measurement write', () => {
    const frames = mockAnimationFrames();
    const calls: string[] = [];

    scheduleMeasurement(
      {},
      {
        read: () => {
          calls.push('read first');
          return 'first';
        },
        measure: (measurement) => {
          calls.push(`measure ${measurement}`);
        },
      }
    );
    scheduleMeasurement(
      {},
      {
        read: () => {
          calls.push('read second');
          return 'second';
        },
        measure: (measurement) => {
          calls.push(`measure ${measurement}`);
        },
      }
    );

    expect(frames.request).toHaveBeenCalledTimes(1);
    frames.runNext();
    expect(calls).toEqual([
      'read first',
      'read second',
      'measure first',
      'measure second',
    ]);
  });

  it('coalesces repeated resize notifications for one component', () => {
    const frames = mockAnimationFrames();
    const key = {};
    const calls: string[] = [];

    scheduleMeasurement(key, {
      read: () => {
        calls.push('stale read');
        return 'stale';
      },
      measure: () => {
        calls.push('stale measure');
      },
    });
    scheduleMeasurement(key, {
      read: () => {
        calls.push('latest read');
        return 'latest';
      },
      measure: (measurement) => {
        calls.push(`measure ${measurement}`);
      },
    });

    expect(frames.request).toHaveBeenCalledTimes(1);
    frames.runNext();
    expect(calls).toEqual(['latest read', 'measure latest']);
  });

  it('cancels the frame after the last pending component unmounts', () => {
    const frames = mockAnimationFrames();
    const first = {};
    const second = {};

    scheduleMeasurement(first, {
      read: () => 'first',
      measure: () => {},
    });
    scheduleMeasurement(second, {
      read: () => 'second',
      measure: () => {},
    });

    cancelMeasurement(first);
    expect(frames.cancel).not.toHaveBeenCalled();

    cancelMeasurement(second);
    expect(frames.cancel).toHaveBeenCalledOnce();
  });
});
