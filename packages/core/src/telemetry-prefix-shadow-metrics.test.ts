import { metrics as otelMetrics } from '@opentelemetry/api';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordEventLogPrefixShadow } from './telemetry.js';

const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
const histogram = { record: vi.fn() };
const meter = {
  createCounter: vi.fn((name: string) => {
    const counter = { add: vi.fn() };
    counters.set(name, counter);
    return counter;
  }),
  createHistogram: vi.fn(() => histogram),
};
otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as any);

afterAll(() => {
  otelMetrics.disable();
});

describe('recordEventLogPrefixShadow', () => {
  it('emits loads, stream and would-skip bytes, and the prefix stream time, on bounded dimensions only', async () => {
    await recordEventLogPrefixShadow({
      source: 'run_started',
      outcome: 'hit',
      wouldClaim: true,
      cachedSlots: 600,
      cachedBytes: 1_000_000,
      entryAgeMs: 1_500,
      streamEvents: 610,
      streamBytes: 1_020_000,
      wouldSkipBytes: 1_000_000,
      timeToPrefixEndMs: 140,
      streamDurationMs: 150,
      denseSlots: 610,
    });
    const dims = {
      'workflow.replay.load.source': 'run_started',
      'workflow.replay.prefix_shadow.outcome': 'hit',
      'workflow.replay.prefix_shadow.would_claim': true,
    };
    expect(
      counters.get('workflow.replay.prefix_shadow.loads')?.add
    ).toHaveBeenCalledWith(1, dims);
    const bytes = counters.get('workflow.replay.prefix_shadow.bytes')?.add;
    expect(bytes).toHaveBeenCalledWith(1_020_000, {
      ...dims,
      'workflow.replay.prefix_shadow.kind': 'stream',
    });
    expect(bytes).toHaveBeenCalledWith(1_000_000, {
      ...dims,
      'workflow.replay.prefix_shadow.kind': 'would_skip',
    });
    expect(histogram.record).toHaveBeenCalledWith(140, dims);
  });

  it('records no would-skip bytes or stream time on a miss', async () => {
    const bytes = counters.get('workflow.replay.prefix_shadow.bytes')?.add;
    bytes?.mockClear();
    histogram.record.mockClear();
    await recordEventLogPrefixShadow({
      source: 'hook_preload',
      outcome: 'miss',
      wouldClaim: false,
      streamEvents: 3,
      streamBytes: 3_000,
      wouldSkipBytes: 0,
      streamDurationMs: 20,
    });
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(histogram.record).not.toHaveBeenCalled();
  });
});
