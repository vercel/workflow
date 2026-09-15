import { metrics as otelMetrics } from '@opentelemetry/api';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { recordStepExecutionDuration } from './telemetry.js';

const histogram = { record: vi.fn() };
const meter = { createHistogram: vi.fn(() => histogram) };
const provider = { getMeter: vi.fn(() => meter) };

otelMetrics.setGlobalMeterProvider(provider as any);

afterAll(() => {
  otelMetrics.disable();
});

describe('recordStepExecutionDuration', () => {
  it('records a millisecond histogram with only a bounded status dimension', async () => {
    await recordStepExecutionDuration(125, 'ok');

    expect(meter.createHistogram).toHaveBeenCalledWith(
      'workflow.step.execute.duration',
      {
        description: 'Duration of user step execution',
        unit: 'ms',
      }
    );
    expect(histogram.record).toHaveBeenCalledWith(125, {
      'workflow.step.status': 'ok',
    });
  });
});
